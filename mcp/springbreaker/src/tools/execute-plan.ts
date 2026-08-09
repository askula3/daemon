import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createChildLogger } from "../utils/logger.js";
import { handleToolError, POMError } from "../utils/errors.js";
import { withProjectLock } from "../utils/lock.js";
import { loadEnvConfig, loadPolicyConfig } from "../config.js";
import { computeProjectFingerprint, computePolicyHash } from "../utils/hash.js";
import { POMWorker } from "../workers/pom-worker.js";
import { MavenWorker } from "../workers/maven-worker.js";
import { GitWorker } from "../workers/git-worker.js";
import { IQWorker } from "../workers/iq-worker.js";
import { NexusWorker } from "../workers/nexus-worker.js";
import { PolicyEngine } from "../engine/policy-engine.js";
import { DependencyGraphBuilder } from "../engine/dependency-graph.js";
import { Planner } from "../engine/planner.js";
import { planStore } from "../store.js";
import { ExecutePlanSchema } from "./schemas.js";
import { buildProjectInfo } from "./project-info.js";
import type {
  ExecutionResult,
  RemediationTask,
  ChangeRecord,
  ErrorRecord,
} from "../types/index.js";

const log = createChildLogger("ExecutePlan");

// Tool: execute_plan
export async function executePlan(
  args: z.infer<typeof ExecutePlanSchema>,
): Promise<{
  content: { type: "text"; text: string }[];
}> {
  return withProjectLock(args.projectPath, async () => {
    try {
      const { projectPath, planId, approvedTasks, dryRun, commit: shouldCommit, createBranch } = args;
      log.info(`Executing plan ${planId} for: ${projectPath}${dryRun ? ' (DRY RUN)' : ''}`);

      // Execution limits (spec §39)
      const policyConfig = loadPolicyConfig(projectPath);
      const maxBatches = policyConfig.maxBatches ?? 10;
      const maxMavenFailures = policyConfig.maxMavenFailures ?? 3;
      const maxReplans = policyConfig.maxReplans ?? 3;
      const maxModifications = policyConfig.maxModifications ?? 50;

      // Look up plan from store
      const plan = planStore.getPlan(planId);
      if (!plan) {
        throw new POMError(`Plan not found: ${planId}. Run build_plan first.`);
      }

      // Load configuration
      const envConfig = loadEnvConfig(projectPath);
      const pomWorker = new POMWorker();
      const mavenWorker = new MavenWorker(
        envConfig.preferMvnw,
        envConfig.mavenOpts,
      );
      const gitWorker = new GitWorker();
      const iqWorker = envConfig.iqServerToken
        ? new IQWorker(
            envConfig.iqServerUrl,
            envConfig.iqServerToken,
            envConfig.iqAppId,
            envConfig.iqUsername,
          )
        : null;

      const executionId = randomUUID();
      const execLog = log.withContext({ executionId, planId, project: projectPath });

      // ── Plan Validation (spec §21) ──────────────────────────────────
      if (plan.projectFingerprint) {
        const currentInfo = await buildProjectInfo(
          projectPath, pomWorker, mavenWorker, gitWorker, envConfig,
        );
        const currentFingerprint = computeProjectFingerprint(
          currentInfo.rootPomContent,
          currentInfo.modules,
          currentInfo.dependencyManagement,
        );
        const currentPolicyHash = computePolicyHash(
          plan.policyUsed as unknown as Record<string, unknown>,
        );

        const reasons: string[] = [];
        if (plan.projectFingerprint !== currentFingerprint) {
          reasons.push('Project files have changed since plan creation');
        }
        if (plan.gitRevision && plan.gitRevision !== currentInfo.gitRevision) {
          reasons.push(
            `Git revision changed: plan was created at ${plan.gitRevision.slice(0, 8)}, ` +
            `now at ${currentInfo.gitRevision.slice(0, 8)}`
          );
        }
        if (plan.policyHash && plan.policyHash !== currentPolicyHash) {
          reasons.push('Policy configuration has changed since plan creation');
        }

        if (reasons.length > 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "PLAN_INVALIDATED",
                message: "Plan is stale and cannot be executed safely. Run build_plan again.",
                reasons,
                planId: plan.id,
              }, null, 2),
            }],
            isError: true,
          };
        }
        execLog.info("Plan validation passed — project state unchanged");
      }

      const changes: ChangeRecord[] = [];
      const errors: ErrorRecord[] = [];
      const pomBackups = new Map<string, string>();
      const completedTaskIds = new Set<string>();

      // Determine which tasks to execute
      const tasksToRun =
        approvedTasks && approvedTasks.length > 0
          ? plan.tasks.filter((t) => approvedTasks.includes(t.id))
          : plan.tasks;

      // ── Dry Run Mode (spec §37) ──────────────────────────────────
      if (dryRun) {
        const dryRunResult = {
          mode: 'dry-run' as const,
          planId: plan.id,
          tasksToExecute: tasksToRun.length,
          tasks: tasksToRun.map(t => ({
            id: t.id,
            priority: t.priority,
            description: t.description,
            component: t.component,
            risk: t.risk,
            confidence: t.confidence,
            dependencies: t.dependencies,
          })),
          batches: plan.batches.length,
          estimatedDuration: plan.estimatedDuration,
          riskAssessment: plan.riskAssessment,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(dryRunResult, null, 2) }],
        };
      }

      const startedAt = new Date().toISOString();
      let tasksCompleted = 0;
      let tasksFailed = 0;
      let tasksSkipped = 0;

      try {
        // Create feature branch for safe rollback (spec §5 — opt-in)
        await gitWorker.init(projectPath);
        if (createBranch) {
          const branchName = `springbreaker/remediation-${executionId.slice(0, 8)}`;
          try {
            await gitWorker.createBranch(projectPath, branchName);
            execLog.info(`Created branch: ${branchName}`);
          } catch (error) {
            execLog.warn(`Could not create branch (continuing on current): ${error}`);
          }
        }

        // Create POM backups BEFORE any modifications
        // Back up ALL POM files (root + modules) for safe rollback
        const allPomFiles = await pomWorker.findPomFiles(projectPath);
        for (const pomPath of allPomFiles) {
          try {
            const backupPath = await pomWorker.backupPom(pomPath);
            pomBackups.set(pomPath, backupPath);
            execLog.info(`POM backup created: ${backupPath}`);
          } catch (error) {
            execLog.error(`Failed to create POM backup for ${pomPath}: ${error}`);
            throw new POMError(
              `Cannot proceed without POM backup for ${pomPath}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        // Execute tasks in batches — build verification happens per-batch, not per-task
        let currentPlan = plan;
        let replanCount = 0;
        let mavenFailureCount = 0;
        let totalBatchesProcessed = 0;
        let totalModifications = changes.length;
        let batchIndex = 0;

        while (batchIndex < currentPlan.batches.length) {
          const batch = currentPlan.batches[batchIndex];
          const batchTasks = batch.filter((t) =>
            tasksToRun.some((r) => r.id === t.id),
          );

          if (batchTasks.length === 0) {
            batchIndex++;
            continue;
          }

          // Enforce execution limits (spec §39)
          if (totalBatchesProcessed >= maxBatches) {
            execLog.warn(`Execution limit reached: max batches (${maxBatches})`);
            errors.push({
              task: "system",
              phase: "execution",
              error: `Execution limit reached: maximum ${maxBatches} batches`,
              rollbackAttempted: false,
              rollbackSuccess: false,
              code: "UNKNOWN",
            });
            break;
          }
          if (mavenFailureCount >= maxMavenFailures) {
            execLog.warn(`Execution limit reached: max Maven failures (${maxMavenFailures})`);
            errors.push({
              task: "system",
              phase: "execution",
              error: `Execution limit reached: maximum ${maxMavenFailures} Maven failures`,
              rollbackAttempted: false,
              rollbackSuccess: false,
              code: "BUILD_FAILED",
            });
            break;
          }
          if (totalModifications >= maxModifications) {
            execLog.warn(`Execution limit reached: max modifications (${maxModifications})`);
            errors.push({
              task: "system",
              phase: "execution",
              error: `Execution limit reached: maximum ${maxModifications} modifications`,
              rollbackAttempted: false,
              rollbackSuccess: false,
              code: "UNKNOWN",
            });
            break;
          }

          // Phase 1: Execute all tasks in this batch
          const batchChanges: ChangeRecord[] = [];

          for (const task of batchTasks) {
            // Check if dependencies are satisfied
            const depsSatisfied = task.dependencies.every((dep) =>
              completedTaskIds.has(dep),
            );
            if (!depsSatisfied) {
              execLog.warn(`Skipping task ${task.id} — dependencies not satisfied`);
              task.status = "skipped";
              tasksSkipped++;
              continue;
            }

            try {
              task.status = "in-progress";
              execLog.info(`Executing task: ${task.description}`);

              const taskResult = await executeRemediationTask(
                task,
                projectPath,
                pomWorker,
                mavenWorker,
                envConfig,
              );

              if (taskResult.success) {
                batchChanges.push(...taskResult.changes);
                task.status = "completed";
              } else {
                task.status = "failed";
                tasksFailed++;
                errors.push({
                  task: task.id,
                  phase: "execution",
                  error: taskResult.error || "Unknown error",
                  rollbackAttempted: false,
                  rollbackSuccess: false,
                });
              }
            } catch (error) {
              task.status = "failed";
              tasksFailed++;
              const errMsg =
                error instanceof Error ? error.message : String(error);
              errors.push({
                task: task.id,
                phase: "execution",
                error: errMsg,
                rollbackAttempted: false,
                rollbackSuccess: false,
              });
              execLog.error(`Task ${task.id} failed: ${errMsg}`);
            }
          }

          // Phase 2: Verify build for the entire batch (not per-task)
          if (batchChanges.length > 0 && currentPlan.policyUsed.verifyBuild) {
            const buildResult = await mavenWorker.cleanVerify(projectPath);
            if (!buildResult.success) {
              execLog.warn(`Batch build failed — rolling back batch`);
              // Rollback ONLY the POMs modified in THIS batch. Restoring all
              // backups would revert earlier successful batches' changes too,
              // silently losing completed work.
              const touchedPoms = new Set(
                batchChanges.map((c) => c.pomPath),
              );
              let rollbackOk = true;
              for (const pomPath of touchedPoms) {
                const backupPath = pomBackups.get(pomPath);
                if (!backupPath) {
                  execLog.error(`No backup for ${pomPath}`);
                  rollbackOk = false;
                  continue;
                }
                try {
                  await pomWorker.restorePom(backupPath, pomPath);
                } catch {
                  execLog.error(`Failed to restore ${pomPath}`);
                  rollbackOk = false;
                }
              }
              // Mark all successful tasks in this batch as rolled-back
              // Note: tasksCompleted was NOT incremented for this batch yet
              // (that only happens in Phase 3 below), so we don't decrement it.
              for (const task of batchTasks) {
                if (task.status === "completed") {
                  task.status = "rolled-back";
                  tasksFailed++;
                }
              }
              errors.push({
                task: "batch",
                phase: "verification",
                error: `Batch build failed: ${buildResult.stderr.slice(-500)}`,
                rollbackAttempted: true,
                rollbackSuccess: rollbackOk,
                code: "BUILD_FAILED",
              });
              mavenFailureCount++;
              totalBatchesProcessed++;
              batchIndex++;
              continue;
            }
          }

          // Phase 3: Batch succeeded — commit changes and update counters
          changes.push(...batchChanges);
          totalModifications += batchChanges.length;
          totalBatchesProcessed++;
          for (const task of batchTasks) {
            if (task.status === "completed") {
              completedTaskIds.add(task.id);
              tasksCompleted++;
            }
          }

          // ── Replan (spec §20) ─────────────────────────────────────
          // After a successful batch, rescan IQ and replan if there's
          // meaningful improvement. This prevents executing stale tasks
          // that may have been resolved by earlier batches.
          if (
            iqWorker &&
            plan.policyUsed.verifyIq &&
            replanCount < maxReplans &&
            batchIndex < currentPlan.batches.length - 1 // not the last batch
          ) {
            try {
              const postBatchReport = await iqWorker.scanAndGetReport(envConfig.iqAppId);
              const remainingVulns = postBatchReport.components.filter(c =>
                c.vulnerabilities.some(v =>
                  currentPlan.policyUsed.severity.includes(v.severity)
                )
              );

              // Compare vulnerability counts, not task counts — a single task
              // may fix multiple vulnerabilities, and a component may have vulns
              // outside the current plan's scope.
              const preBatchVulnCount = currentPlan.vulnerabilitiesBySeverity.total;
              if (remainingVulns.length < preBatchVulnCount) {
                execLog.info(
                  `Replan #${replanCount + 1}: ${remainingVulns.length} components remaining ` +
                  `(${tasksToRun.length - tasksCompleted} tasks left in current plan)`
                );

                // Rebuild graph and replan
                const graphBuilder = new DependencyGraphBuilder();
                const treeOutput = await mavenWorker.getDependencyTree(projectPath);
                graphBuilder.buildFromMavenTree(treeOutput);
                const projectInfo = await buildProjectInfo(
                  projectPath, pomWorker, mavenWorker, gitWorker, envConfig,
                );
                graphBuilder.markSpringBootManaged(projectInfo);
                graphBuilder.markDependencyManagement(projectInfo.dependencyManagement);
                graphBuilder.markVulnerableComponents(postBatchReport);

                const policyEngine = new PolicyEngine(currentPlan.policyUsed);
                const nexusWorker = envConfig.nexusUsername
                  ? new NexusWorker(envConfig.nexusUrl, envConfig.nexusUsername, envConfig.nexusPassword)
                  : null;
                const planner = new Planner(policyEngine, graphBuilder, nexusWorker);

                const filteredComponents = policyEngine.filterComponentsByPolicy(postBatchReport.components);
                const newPlan = await planner.createPlan(filteredComponents, envConfig.iqAppId, projectInfo);

                // Set lineage
                newPlan.previousPlanId = currentPlan.id;
                newPlan.gitRevision = projectInfo.gitRevision;
                newPlan.projectFingerprint = computeProjectFingerprint(
                  projectInfo.rootPomContent,
                  projectInfo.modules,
                  projectInfo.dependencyManagement,
                );
                newPlan.policyHash = computePolicyHash(
                  currentPlan.policyUsed as unknown as Record<string, unknown>,
                );

                planStore.savePlan(newPlan);

                // Merge completed tasks from old plan into new plan.
                // New plan tasks have fresh UUIDs, so we match by component
                // identity (groupId:artifactId) instead of task ID.
                const completedComponents = new Set(
                  currentPlan.tasks
                    .filter(t => completedTaskIds.has(t.id))
                    .map(t => `${t.component.groupId}:${t.component.artifactId}`)
                );
                for (const newTask of newPlan.tasks) {
                  const key = `${newTask.component.groupId}:${newTask.component.artifactId}`;
                  if (completedComponents.has(key)) {
                    newTask.status = "completed";
                  }
                }

                currentPlan = newPlan;
                replanCount++;
                execLog.info(`Replan complete: new plan has ${newPlan.tasks.length} tasks in ${newPlan.batches.length} batches`);
              }
            } catch (error) {
              execLog.warn(`Replan failed (continuing with current plan): ${error}`);
            }
          }

          // Advance to next batch
          batchIndex++;
        } // end while (batch loop)

        // Commit changes only when explicitly requested (spec §5)
        if (shouldCommit && changes.length > 0) {
          try {
            await gitWorker.add(projectPath, ".");
            await gitWorker.commit(
              projectPath,
              `springbreaker: remediate ${tasksCompleted} vulnerabilities (${executionId.slice(0, 8)})`,
            );
            execLog.info("Changes committed");
          } catch (error) {
            execLog.warn(`Could not commit changes: ${error}`);
          }
        } else if (changes.length > 0) {
          execLog.info(`Changes applied but not committed (commit flag not set)`);
        }

        // Run IQ scan to count remaining vulnerabilities
        let vulnerabilitiesAfter = 0;
        let iqScanSuccess = true;
        const vulnerabilitiesBySeverityAfter = {
          total: 0, critical: 0, high: 0, medium: 0, low: 0,
        };
        if (iqWorker) {
          try {
            const iqReport = await iqWorker.scanAndGetReport(envConfig.iqAppId);
            vulnerabilitiesAfter = iqReport.totalVulnerabilities;
            vulnerabilitiesBySeverityAfter.total = iqReport.totalVulnerabilities;
            vulnerabilitiesBySeverityAfter.critical = iqReport.vulnerabilitiesBySeverity.CRITICAL;
            vulnerabilitiesBySeverityAfter.high = iqReport.vulnerabilitiesBySeverity.HIGH;
            vulnerabilitiesBySeverityAfter.medium = iqReport.vulnerabilitiesBySeverity.MEDIUM;
            vulnerabilitiesBySeverityAfter.low = iqReport.vulnerabilitiesBySeverity.LOW;
          } catch (error) {
            execLog.warn(`IQ rescan failed: ${error}`);
            iqScanSuccess = false;
          }
        }

        const completedAt = new Date().toISOString();
        const result: ExecutionResult = {
          executionId,
          planId,
          startedAt,
          completedAt,
          status:
            tasksFailed === 0
              ? "completed"
              : tasksCompleted > 0
                ? "partial"
                : "failed",
          tasksCompleted,
          tasksFailed,
          tasksSkipped,
          buildSuccess: tasksFailed === 0,
          iqScanSuccess,
          vulnerabilitiesBefore: plan.vulnerabilitiesBySeverity.total,
          vulnerabilitiesAfter,
          vulnerabilitiesResolved: tasksCompleted,
          remainingVulnerabilities: vulnerabilitiesAfter,
          vulnerabilitiesBySeverityBefore: plan.vulnerabilitiesBySeverity,
          vulnerabilitiesBySeverityAfter,
          changes,
          errors,
        };

        // Persist execution state
        planStore.saveExecution({
          executionId,
          plan,
          result,
          pomBackups,
          startedAt,
          completedAt,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        // Catastrophic failure — try to restore all backups
        for (const [pomPath, backupPath] of pomBackups) {
          try {
            await pomWorker.restorePom(backupPath, pomPath);
          } catch {
            execLog.error(`Failed to restore ${pomPath} from ${backupPath}`);
          }
        }

        const completedAt = new Date().toISOString();
        const emptySeverity = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
        const result: ExecutionResult = {
          executionId,
          planId,
          startedAt,
          completedAt,
          status: "failed",
          tasksCompleted,
          tasksFailed,
          tasksSkipped,
          buildSuccess: false,
          iqScanSuccess: false,
          vulnerabilitiesBefore: 0,
          vulnerabilitiesAfter: 0,
          vulnerabilitiesResolved: 0,
          remainingVulnerabilities: 0,
          vulnerabilitiesBySeverityBefore: emptySeverity,
          vulnerabilitiesBySeverityAfter: emptySeverity,
          changes,
          errors: [
            ...errors,
            {
              task: "global",
              phase: "execution",
              error: error instanceof Error ? error.message : String(error),
              rollbackAttempted: true,
              rollbackSuccess: false,
            },
          ],
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    } catch (error) {
      return handleToolError(error);
    }
  });
}

// Internal: execute a single remediation task
async function executeRemediationTask(
  task: RemediationTask,
  projectPath: string,
  pomWorker: POMWorker,
  _mavenWorker: MavenWorker,
  _envConfig: ReturnType<typeof loadEnvConfig>,
): Promise<{ success: boolean; changes: ChangeRecord[]; error?: string }> {
  const { component, priority } = task;
  // Multi-module support: a task may target a specific module POM. Fall back
  // to the root POM when no module/pomPath is set.
  const targetPomPath = task.pomPath ?? `${projectPath}/pom.xml`;
  const pomData = await pomWorker.readPom(targetPomPath);

  const changes: ChangeRecord[] = [];

  switch (priority) {
    case "upgrade-spring-boot-parent": {
      const updated = pomWorker.updateParentVersion(
        pomData,
        component.targetVersion,
      );
      if (updated) {
        await pomWorker.writePom(targetPomPath, pomData);
        changes.push({
          task: task.id,
          pomPath: targetPomPath,
          timestamp: new Date().toISOString(),
          type: "upgrade",
          before: component.currentVersion,
          after: component.targetVersion,
        });
      }
      break;
    }

    case "upgrade-owning-direct-dependency":
    case "upgrade-direct-dependency":
    case "apply-iq-suggestion":
    case "search-nexus-latest":
    case "override-transitive": {
      const updated = pomWorker.updateDependencyVersion(
        pomData,
        component.groupId,
        component.artifactId,
        component.targetVersion,
      );
      if (updated) {
        await pomWorker.writePom(targetPomPath, pomData);
        changes.push({
          task: task.id,
          pomPath: targetPomPath,
          timestamp: new Date().toISOString(),
          type: "upgrade",
          before: component.currentVersion,
          after: component.targetVersion,
        });
      } else {
        return {
          success: false,
          changes: [],
          error: `Dependency ${component.groupId}:${component.artifactId} not found in POM dependencies`,
        };
      }
      break;
    }

    case "exclude-and-replace": {
      // Exclude the vulnerable transitive from its owning dependency,
      // then add the replacement at a safe version.
      const ownerG = task.metadata?.ownerGroupId;
      const ownerA = task.metadata?.ownerArtifactId;
      if (!ownerG || !ownerA) {
        return {
          success: false,
          changes: [],
          error: "exclude-and-replace requires ownerGroupId and ownerArtifactId in task metadata",
        };
      }

      // Step 1: Add exclusion to the owning dependency
      const excluded = pomWorker.addExclusion(
        pomData, ownerG, ownerA,
        component.groupId, component.artifactId,
      );

      // Step 2: Add replacement dependency at the safe version
      pomWorker.addDependency(
        pomData,
        component.groupId,
        component.artifactId,
        component.targetVersion,
      );

      if (excluded) {
        await pomWorker.writePom(targetPomPath, pomData);
        changes.push({
          task: task.id,
          pomPath: targetPomPath,
          timestamp: new Date().toISOString(),
          type: "exclude",
          before: `${component.groupId}:${component.artifactId}:${component.currentVersion} (via ${ownerG}:${ownerA})`,
          after: `${component.groupId}:${component.artifactId}:${component.targetVersion} (excluded from ${ownerG}:${ownerA})`,
        });
      } else {
        return {
          success: false,
          changes: [],
          error: `Could not add exclusion for ${component.groupId}:${component.artifactId} from ${ownerG}:${ownerA}`,
        };
      }
      break;
    }

    case "remove-unused": {
      const removed = pomWorker.removeDependency(
        pomData,
        component.groupId,
        component.artifactId,
      );
      if (removed) {
        await pomWorker.writePom(targetPomPath, pomData);
        changes.push({
          task: task.id,
          pomPath: targetPomPath,
          timestamp: new Date().toISOString(),
          type: "remove",
          before: component.currentVersion,
          after: "(removed)",
        });
      }
      break;
    }

    default:
      return {
        success: false,
        changes: [],
        error: `Unknown priority: ${priority}`,
      };
  }

  return { success: true, changes };
}
