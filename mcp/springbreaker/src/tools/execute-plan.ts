import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createChildLogger } from "../utils/logger.js";
import { handleToolError, POMError } from "../utils/errors.js";
import { withProjectLock } from "../utils/lock.js";
import { loadEnvConfig } from "../config.js";
import { computeProjectFingerprint, computePolicyHash, computeServiceConfigHash } from "../utils/hash.js";
import { POMWorker } from "../workers/pom-worker.js";
import { MavenWorker } from "../workers/maven-worker.js";
import { GitWorker } from "../workers/git-worker.js";
import { IQWorker } from "../workers/iq-worker.js";
import { NexusWorker } from "../workers/nexus-worker.js";
import { MavenCentralWorker } from "../workers/maven-central-worker.js";
import { PolicyEngine } from "../engine/policy-engine.js";
import { DependencyGraphBuilder } from "../engine/dependency-graph.js";
import { Planner } from "../engine/planner.js";
import { planStore } from "../store.js";
import { ExecutePlanSchema } from "./schemas.js";
import { analyzeProjectUsage, buildProjectInfo } from "./project-info.js";
import { assertPathWithinProject, resolveProjectPath } from "../utils/project-path.js";
import { scanProjectWithIq } from "./iq-scan.js";
import type { ToolContext } from "./context.js";
import type {
  ExecutionResult,
  RemediationTask,
  ChangeRecord,
  ErrorRecord,
  FailureCode,
  VulnerabilityOccurrence,
  ExecutionPlan,
} from "../types/index.js";

const log = createChildLogger("ExecutePlan");

function occurrenceKey(occurrence: VulnerabilityOccurrence): string {
  return [
    occurrence.groupId,
    occurrence.artifactId,
    occurrence.version,
    occurrence.vulnerabilityId,
  ].join("\u0000");
}

function approvalKey(task: RemediationTask): string {
  return [
    task.priority,
    task.component.groupId,
    task.component.artifactId,
    task.component.currentVersion,
    task.component.targetVersion,
    task.pomPath ?? "",
  ].join("\u0000");
}

// Tool: execute_plan
export async function executePlan(
  args: z.infer<typeof ExecutePlanSchema>,
  context?: ToolContext,
): Promise<{
  content: { type: "text"; text: string }[];
}> {
  let projectPath: string;
  try {
    projectPath = await resolveProjectPath(args.projectPath);
  } catch (error) {
    return handleToolError(error);
  }
  return withProjectLock(projectPath, async () => {
    try {
      const {
        planId,
        approvedTasks,
        approveAll,
        dryRun,
        commit: shouldCommit,
        createBranch,
      } = args;
      log.info(
        `Executing plan ${planId} for: ${projectPath}${dryRun ? " (DRY RUN)" : ""}`,
      );

      // Look up plan from store
      const plan = planStore.getPlan(planId);
      if (!plan) {
        throw new POMError(`Plan not found: ${planId}. Run build_plan first.`);
      }
      if (plan.projectPath !== projectPath) {
        throw new POMError(`Plan ${planId} does not belong to project: ${projectPath}`);
      }
      const policyConfig = plan.policyUsed;
      const maxBatches = policyConfig.maxBatches ?? 10;
      const maxMavenFailures = policyConfig.maxMavenFailures ?? 3;
      const maxReplans = policyConfig.maxReplans ?? 3;
      const maxModifications = policyConfig.maxModifications ?? 50;

      // Load configuration
      const envConfig = loadEnvConfig(projectPath);
      const pomWorker = new POMWorker();
      const mavenWorker = new MavenWorker(
        envConfig.preferMvnw,
        envConfig.mavenOpts,
        envConfig.mavenEnvAllowlist,
      );
      const gitWorker = new GitWorker();
      const iqWorker = envConfig.iqServerToken && envConfig.iqAppId
        ? new IQWorker(
            envConfig.iqServerUrl,
            envConfig.iqServerToken,
            envConfig.iqAppId,
            envConfig.iqUsername,
            envConfig.allowInsecureHttp,
          )
        : null;

      const executionId = randomUUID();
      const execLog = log.withContext({
        executionId,
        planId,
        project: projectPath,
      });

      // ── Plan Validation (spec §21) ──────────────────────────────────
      if (plan.projectFingerprint) {
        const currentInfo = await buildProjectInfo(
          projectPath,
          pomWorker,
          mavenWorker,
          gitWorker,
          envConfig,
        );
        const currentFingerprint = computeProjectFingerprint(
          currentInfo.rootPomContent,
          currentInfo.modules,
          currentInfo.dependencyManagement,
          currentInfo.fingerprintFiles,
        );
        const currentPolicyHash = computePolicyHash(
          plan.policyUsed as unknown as Record<string, unknown>,
        );

        const reasons: string[] = [];
        if (plan.projectFingerprint !== currentFingerprint) {
          reasons.push("Project files have changed since plan creation");
        }
        if (plan.gitRevision && plan.gitRevision !== currentInfo.gitRevision) {
          reasons.push(
            `Git revision changed: plan was created at ${plan.gitRevision.slice(0, 8)}, ` +
              `now at ${currentInfo.gitRevision.slice(0, 8)}`,
          );
        }
        if (plan.policyHash && plan.policyHash !== currentPolicyHash) {
          reasons.push("Policy configuration has changed since plan creation");
        }
        if (
          plan.serviceConfigHash &&
          plan.serviceConfigHash !== computeServiceConfigHash(envConfig)
        ) {
          reasons.push("IQ/Nexus endpoint or IQ application configuration has changed");
        }

        if (reasons.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "PLAN_INVALIDATED",
                    message:
                      "Plan is stale and cannot be executed safely. Run build_plan again.",
                    reasons,
                    planId: plan.id,
                  },
                  null,
                  2,
                ),
              },
            ],
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
      let tasksToRun =
        !approveAll && approvedTasks && approvedTasks.length > 0
          ? plan.tasks.filter((t) => approvedTasks.includes(t.id))
          : plan.tasks;
      if (!dryRun && !approveAll && !approvedTasks?.length) {
        throw new POMError(
          "Explicit task approval is required: set approveAll=true or provide approvedTasks",
        );
      }
      if (approveAll && approvedTasks) {
        throw new POMError("Use either approveAll or approvedTasks, not both");
      }
      const unknownTaskIds = approvedTasks?.filter(
        (taskId) => !plan.tasks.some((task) => task.id === taskId),
      ) ?? [];
      if (unknownTaskIds.length > 0) {
        throw new POMError(
          `Approved task IDs are not in plan ${planId}: ${unknownTaskIds.join(", ")}`,
        );
      }
      const approvedActionKeys = new Set(tasksToRun.map(approvalKey));

      // ── Dry Run Mode (spec §37) ──────────────────────────────────
      if (dryRun) {
        const dryRunResult = {
          mode: "dry-run" as const,
          planId: plan.id,
          tasksToExecute: tasksToRun.length,
          tasks: tasksToRun.map((t) => ({
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
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(dryRunResult, null, 2),
            },
          ],
        };
      }

      const startedAt = new Date().toISOString();
      let tasksCompleted = 0;
      let tasksFailed = 0;
      let tasksSkipped = 0;
      let buildVerificationRan = false;
      let iqVerificationRan = false;
      let continuationPlanId: string | undefined;
      let continuationPlan: ExecutionPlan | undefined;

      // Fail non-mutating Git preflight before claiming this one-shot plan.
      const isGitRepo = await gitWorker.isGitRepo(projectPath);
      if ((createBranch || shouldCommit) && !isGitRepo) {
        throw new POMError("createBranch/commit requires the project to be a Git repository");
      }
      if (createBranch || shouldCommit) {
        const gitStatus = await gitWorker.getStatus(projectPath);
        if (!gitStatus.isClean) {
          throw new POMError(
            "createBranch/commit requires a clean Git working tree so existing user changes cannot be committed",
          );
        }
      }

      const backupDirectory = await mkdtemp(join(tmpdir(), "springbreaker-execution-"));

      try {
        // Create POM backups BEFORE any modifications
        // Back up ALL POM files (root + modules) for safe rollback
        const allPomFiles = await pomWorker.findPomFiles(projectPath);
        for (const pomPath of allPomFiles) {
          try {
            const backupPath = await pomWorker.backupPom(pomPath, backupDirectory);
            pomBackups.set(pomPath, backupPath);
            execLog.info(`POM backup created: ${backupPath}`);
          } catch (error) {
            execLog.error(
              `Failed to create POM backup for ${pomPath}: ${error}`,
            );
            throw new POMError(
              `Cannot proceed without POM backup for ${pomPath}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        // Claim only after all non-mutating preconditions and backups pass.
        // From this point onward, failures may follow a partial external or
        // filesystem mutation and therefore require a fresh plan.
        if (!planStore.claimPlan(planId)) {
          return handleToolError(
            new POMError(
              `Plan ${planId} has already been executed. Build a new plan before retrying.`,
            ),
          );
        }

        // Create feature branch for safe rollback (spec §5 — opt-in)
        if (createBranch) {
          const branchName = `springbreaker/remediation-${executionId.slice(0, 8)}`;
          await gitWorker.createBranch(projectPath, branchName);
          execLog.info(`Created branch: ${branchName}`);
        }

        // Execute tasks in batches — build verification happens per-batch, not per-task
        let currentPlan = plan;
        let replanCount = 0;
        let mavenFailureCount = 0;
        let totalBatchesProcessed = 0;
        let totalModifications = changes.length;
        let batchIndex = 0;
        let lastScopedVulnerabilities = new Set(
          plan.vulnerabilityOccurrences.map(occurrenceKey),
        );

        while (batchIndex < currentPlan.batches.length) {
          if (context?.signal?.aborted) throw new POMError("Execution cancelled by client");
          await context?.progress?.(
            totalBatchesProcessed,
            Math.min(currentPlan.batches.length, maxBatches),
            `Executing remediation batch ${batchIndex + 1}`,
          );
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
            execLog.warn(
              `Execution limit reached: max batches (${maxBatches})`,
            );
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
            execLog.warn(
              `Execution limit reached: max Maven failures (${maxMavenFailures})`,
            );
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
            execLog.warn(
              `Execution limit reached: max modifications (${maxModifications})`,
            );
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
          const batchBackups = new Map<string, string>();
          for (const pomPath of allPomFiles) {
            batchBackups.set(
              pomPath,
              await pomWorker.backupPom(pomPath, backupDirectory),
            );
          }

          for (const task of batchTasks) {
            // Check if dependencies are satisfied
            const depsSatisfied = task.dependencies.every((dep) =>
              completedTaskIds.has(dep),
            );
            if (!depsSatisfied) {
              execLog.warn(
                `Skipping task ${task.id} — dependencies not satisfied`,
              );
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
                const errorCode: FailureCode = taskResult.error?.includes(
                  "not found in POM",
                )
                  ? "VERSION_NOT_AVAILABLE"
                  : taskResult.error?.includes("exclude-and-replace requires")
                    ? "INCOMPATIBLE_UPGRADE"
                    : "UNKNOWN";
                errors.push({
                  task: task.id,
                  phase: "execution",
                  error: taskResult.error || "Unknown error",
                  rollbackAttempted: false,
                  rollbackSuccess: false,
                  code: errorCode,
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
                code: "UNKNOWN",
              });
              execLog.error(`Task ${task.id} failed: ${errMsg}`);
            }
          }

          const rollbackBatch = async (
            message: string,
            code: FailureCode,
          ): Promise<void> => {
            const touchedPoms = new Set(batchChanges.map((change) => change.pomPath));
            let rollbackOk = true;
            for (const pomPath of touchedPoms) {
              const backupPath = batchBackups.get(pomPath);
              if (!backupPath) {
                rollbackOk = false;
                continue;
              }
              try {
                await pomWorker.restorePom(backupPath, pomPath);
              } catch {
                rollbackOk = false;
                execLog.error(`Failed to restore ${pomPath}`);
              }
            }
            for (const task of batchTasks) {
              if (task.status === "completed") {
                task.status = "rolled-back";
                tasksFailed++;
              }
            }
            errors.push({
              task: "batch",
              phase: "verification",
              error: message,
              rollbackAttempted: true,
              rollbackSuccess: rollbackOk,
              code,
            });
            totalBatchesProcessed++;
          };

          if (totalModifications + batchChanges.length > maxModifications) {
            await rollbackBatch(
              `Execution limit reached: maximum ${maxModifications} modifications`,
              "UNKNOWN",
            );
            break;
          }

          // Phase 2: Verify build for the entire batch (not per-task)
          if (batchChanges.length > 0 && currentPlan.policyUsed.verifyBuild) {
            const buildResult = await mavenWorker.cleanVerify(projectPath, false, {
              timeout: policyConfig.timeout,
              signal: context?.signal,
            });
            buildVerificationRan = true;
            if (!buildResult.success) {
              execLog.warn(`Batch build failed — rolling back batch`);
              await rollbackBatch(
                `Batch build failed: ${buildResult.stderr.slice(-500)}`,
                "BUILD_FAILED",
              );
              mavenFailureCount++;
              batchIndex++;
              continue;
            }
          }

          let postBatchReport = null;
          if (batchChanges.length > 0 && currentPlan.policyUsed.verifyIq) {
            if (!iqWorker) {
              await rollbackBatch("IQ verification is required but IQ is not configured", "IQ_UNAVAILABLE");
              batchIndex++;
              continue;
            }
            try {
              postBatchReport = await scanProjectWithIq(
                projectPath,
                mavenWorker,
                iqWorker,
                policyConfig.timeout ?? 300_000,
                context?.signal,
              );
              iqVerificationRan = true;
              const scopedAfter = new Set(
                postBatchReport.components.flatMap((component) =>
                  component.vulnerabilities
                    .filter((vulnerability) => currentPlan.policyUsed.severity.includes(vulnerability.severity))
                    .map((vulnerability) => occurrenceKey({
                      groupId: component.groupId,
                      artifactId: component.artifactId,
                      version: component.version,
                      vulnerabilityId: vulnerability.id,
                    })),
                ),
              );
              const expected = new Set(
                batchTasks.flatMap((task) => task.expectedVulnerabilities.map(occurrenceKey)),
              );
              const unresolved = [...expected].filter((key) => scopedAfter.has(key));
              const hasUnprovenCandidate = batchTasks.some((task) => task.expectedFixes.length === 0);
              const improved = scopedAfter.size < lastScopedVulnerabilities.size;
              if (unresolved.length > 0 || (hasUnprovenCandidate && !improved)) {
                await rollbackBatch(
                  unresolved.length > 0
                    ? `IQ verification found ${unresolved.length} expected vulnerability ID(s) still present`
                    : "IQ verification found no vulnerability reduction for an unproven repository candidate",
                  "INCOMPATIBLE_UPGRADE",
                );
                batchIndex++;
                continue;
              }
              lastScopedVulnerabilities = scopedAfter;
            } catch (error) {
              await rollbackBatch(
                `IQ verification failed: ${error instanceof Error ? error.message : String(error)}`,
                "IQ_UNAVAILABLE",
              );
              if (context?.signal?.aborted) throw error;
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
            postBatchReport &&
            plan.policyUsed.verifyIq &&
            replanCount < maxReplans &&
            batchIndex < currentPlan.batches.length - 1 // not the last batch
          ) {
            try {
              const remainingVulnerabilityCount = lastScopedVulnerabilities.size;
              if (remainingVulnerabilityCount < currentPlan.vulnerabilitiesBySeverity.total) {
                execLog.info(
                  `Replan #${replanCount + 1}: ${remainingVulnerabilityCount} vulnerabilities remaining ` +
                    `(${tasksToRun.length - tasksCompleted} tasks left in current plan)`,
                );

                // Rebuild graph and replan
                const graphBuilder = new DependencyGraphBuilder();
                const treeOutput =
                  await mavenWorker.getDependencyTree(projectPath, {
                    timeout: policyConfig.timeout,
                    signal: context?.signal,
                  });
                graphBuilder.buildFromMavenTree(treeOutput);
                const projectInfo = await buildProjectInfo(
                  projectPath,
                  pomWorker,
                  mavenWorker,
                  gitWorker,
                  envConfig,
                );
                if (currentPlan.policyUsed.removeUnused) {
                  await analyzeProjectUsage(
                    projectInfo,
                    mavenWorker,
                    policyConfig.timeout,
                    context?.signal,
                  );
                }
                graphBuilder.markSpringBootManaged(projectInfo);
                graphBuilder.markDependencyManagement(
                  projectInfo.dependencyManagement,
                );
                graphBuilder.markVulnerableComponents(postBatchReport);

                const policyEngine = new PolicyEngine(currentPlan.policyUsed);
                const nexusWorker = envConfig.nexusUsername
                  ? new NexusWorker(
                      envConfig.nexusUrl,
                      envConfig.nexusUsername,
                      envConfig.nexusPassword,
                      envConfig.allowInsecureHttp,
                    )
                  : null;
                const planner = new Planner(
                  policyEngine,
                  graphBuilder,
                  nexusWorker,
                  new MavenCentralWorker(),
                );

                const filteredComponents =
                  policyEngine.filterComponentsByPolicy(
                    postBatchReport.components,
                  );
                const newPlan = await planner.createPlan(
                  filteredComponents,
                  envConfig.iqAppId,
                  projectInfo,
                  context?.signal,
                );

                // Set lineage
                newPlan.previousPlanId = currentPlan.id;
                newPlan.gitRevision = projectInfo.gitRevision;
                newPlan.projectFingerprint = computeProjectFingerprint(
                  projectInfo.rootPomContent,
                  projectInfo.modules,
                  projectInfo.dependencyManagement,
                  projectInfo.fingerprintFiles,
                );
                newPlan.policyHash = computePolicyHash(
                  currentPlan.policyUsed as unknown as Record<string, unknown>,
                );
                newPlan.serviceConfigHash = computeServiceConfigHash(envConfig);

                // A replan may update targets or introduce entirely new
                // actions. Never treat approval for the original immutable
                // plan as approval for those changed actions.
                const unapprovedReplannedTasks = newPlan.tasks.filter(
                  (task) => !approvedActionKeys.has(approvalKey(task)),
                );
                if (unapprovedReplannedTasks.length > 0) {
                  continuationPlan = newPlan;
                  continuationPlanId = newPlan.id;
                  tasksSkipped += unapprovedReplannedTasks.length;
                  errors.push({
                    task: "replan",
                    phase: "approval",
                    error:
                      `Replanning produced ${unapprovedReplannedTasks.length} changed action(s); ` +
                      `review and execute continuation plan ${newPlan.id}`,
                    rollbackAttempted: false,
                    rollbackSuccess: false,
                    code: "APPROVAL_REQUIRED",
                  });
                  execLog.info(
                    `Paused for approval of continuation plan ${newPlan.id}`,
                  );
                  break;
                }

                currentPlan = newPlan;
                // The latest IQ report is authoritative: every task in the new
                // plan corresponds to a vulnerability occurrence still present.
                tasksToRun = newPlan.tasks;
                completedTaskIds.clear();
                batchIndex = -1;
                replanCount++;
                execLog.info(
                  `Replan complete: new plan has ${newPlan.tasks.length} tasks in ${newPlan.batches.length} batches`,
                );
              }
            } catch (error) {
              if (context?.signal?.aborted) throw error;
              execLog.warn(
                `Replan failed (continuing with current plan): ${error}`,
              );
            }
          }

          // Advance to next batch
          batchIndex++;
        } // end while (batch loop)

        // Commit changes only when explicitly requested (spec §5)
        if (shouldCommit && changes.length > 0) {
          const changedPoms = [...new Set(changes.map((change) => change.pomPath))];
          await gitWorker.commitFiles(
            projectPath,
            changedPoms,
            `springbreaker: apply ${tasksCompleted} remediation task(s) (${executionId.slice(0, 8)})`,
          );
          execLog.info("Changes committed");
        } else if (changes.length > 0) {
          execLog.info(
            `Changes applied but not committed (commit flag not set)`,
          );
        }

        // Persist a continuation only after optional commit has settled, so
        // its Git revision cannot be stale the moment it is returned.
        if (continuationPlan) {
          if (isGitRepo) {
            continuationPlan.gitRevision = await gitWorker.getLastCommitHash(projectPath);
          }
          planStore.savePlan(continuationPlan);
        }

        // Run a final scoped IQ scan. When verification is unavailable, keep
        // the pre-execution counts instead of reporting a false zero.
        let vulnerabilitiesAfter = plan.vulnerabilitiesBySeverity.total;
        let iqScanSuccess = false;
        let vulnerabilitiesBySeverityAfter = { ...plan.vulnerabilitiesBySeverity };
        if (iqWorker && plan.policyUsed.verifyIq) {
          try {
            const iqReport = await scanProjectWithIq(
              projectPath,
              mavenWorker,
              iqWorker,
              policyConfig.timeout ?? 300_000,
              context?.signal,
            );
            const scoped = iqReport.components.flatMap((component) =>
              component.vulnerabilities.filter((vulnerability) =>
                plan.policyUsed.severity.includes(vulnerability.severity),
              ),
            );
            vulnerabilitiesBySeverityAfter = {
              total: scoped.length,
              critical: scoped.filter((item) => item.severity === "CRITICAL").length,
              high: scoped.filter((item) => item.severity === "HIGH").length,
              medium: scoped.filter((item) => item.severity === "MEDIUM").length,
              low: scoped.filter((item) => item.severity === "LOW").length,
            };
            vulnerabilitiesAfter = scoped.length;
            iqScanSuccess = true;
            iqVerificationRan = true;
          } catch (error) {
            if (context?.signal?.aborted) throw error;
            execLog.warn(`IQ rescan failed: ${error}`);
            errors.push({
              task: "system",
              phase: "final-iq-verification",
              error: error instanceof Error ? error.message : String(error),
              rollbackAttempted: false,
              rollbackSuccess: false,
              code: "IQ_UNAVAILABLE",
            });
          }
        }

        const completedAt = new Date().toISOString();
        const result: ExecutionResult = {
          executionId,
          planId,
          startedAt,
          completedAt,
          status:
            errors.length === 0 && tasksFailed === 0 && tasksSkipped === 0
              ? "completed"
              : tasksCompleted > 0
                ? "partial"
                : "failed",
          tasksCompleted,
          tasksFailed,
          tasksSkipped,
          buildSuccess:
            buildVerificationRan && !errors.some((item) => item.code === "BUILD_FAILED"),
          buildVerified: buildVerificationRan,
          iqScanSuccess,
          iqVerified: iqVerificationRan && iqScanSuccess,
          vulnerabilitiesBefore: plan.vulnerabilitiesBySeverity.total,
          vulnerabilitiesAfter,
          vulnerabilitiesResolved: iqScanSuccess
            ? Math.max(0, plan.vulnerabilitiesBySeverity.total - vulnerabilitiesAfter)
            : 0,
          remainingVulnerabilities: vulnerabilitiesAfter,
          vulnerabilitiesBySeverityBefore: plan.vulnerabilitiesBySeverity,
          vulnerabilitiesBySeverityAfter,
          changes,
          errors,
          continuationPlanId,
        };

        // Persist execution state
        planStore.saveExecution({
          executionId,
          plan,
          result,
          pomBackups: new Map(),
          startedAt,
          completedAt,
        });
        await rm(backupDirectory, { recursive: true, force: true }).catch((error) =>
          execLog.warn(`Failed to clean temporary backups: ${error}`),
        );

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
        let rollbackSuccess = pomBackups.size > 0;
        for (const [pomPath, backupPath] of pomBackups) {
          try {
            await pomWorker.restorePom(backupPath, pomPath);
          } catch {
            execLog.error(`Failed to restore ${pomPath} from ${backupPath}`);
            rollbackSuccess = false;
          }
        }
        await rm(backupDirectory, { recursive: true, force: true }).catch((cleanupError) =>
          execLog.warn(`Failed to clean temporary backups: ${cleanupError}`),
        );

        const completedAt = new Date().toISOString();
        const result: ExecutionResult = {
          executionId,
          planId,
          startedAt,
          completedAt,
          status: "failed",
          tasksCompleted: rollbackSuccess ? 0 : tasksCompleted,
          tasksFailed,
          tasksSkipped,
          buildSuccess: false,
          buildVerified: buildVerificationRan,
          iqScanSuccess: false,
          iqVerified: false,
          vulnerabilitiesBefore: plan.vulnerabilitiesBySeverity.total,
          vulnerabilitiesAfter: plan.vulnerabilitiesBySeverity.total,
          vulnerabilitiesResolved: 0,
          remainingVulnerabilities: plan.vulnerabilitiesBySeverity.total,
          vulnerabilitiesBySeverityBefore: plan.vulnerabilitiesBySeverity,
          vulnerabilitiesBySeverityAfter: plan.vulnerabilitiesBySeverity,
          changes: rollbackSuccess ? [] : changes,
          errors: [
            ...errors,
            {
              task: "global",
              phase: "execution",
              error: error instanceof Error ? error.message : String(error),
              rollbackAttempted: true,
              rollbackSuccess,
            },
          ],
        };

        planStore.saveExecution({
          executionId,
          plan,
          result,
          pomBackups: new Map(),
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
  const targetPomPath = await assertPathWithinProject(
    projectPath,
    task.pomPath ?? `${projectPath}/pom.xml`,
  );
  const pomData = await pomWorker.readPom(targetPomPath);

  const changes: ChangeRecord[] = [];

  switch (priority) {
    case "upgrade-spring-boot-parent": {
      const source = task.metadata?.springBootVersionSource;
      const propertyName = task.metadata?.springBootVersionProperty;
      const updated = source === "property" && typeof propertyName === "string"
        ? pomWorker.updateProperty(pomData, propertyName, component.targetVersion)
        : source === "dependency-management"
          ? pomWorker.updateDependencyVersion(
              pomData,
              "org.springframework.boot",
              "spring-boot-dependencies",
              component.targetVersion,
            )
          : pomWorker.updateParentVersion(pomData, component.targetVersion);
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
          error: "Spring Boot parent was not found in the target POM",
        };
      }
      break;
    }

    case "upgrade-owning-direct-dependency":
    case "upgrade-direct-dependency":
    case "apply-iq-suggestion":
    case "search-nexus-latest": {
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

    case "override-transitive": {
      pomWorker.setManagedDependencyVersion(
        pomData,
        component.groupId,
        component.artifactId,
        component.targetVersion,
      );
      await pomWorker.writePom(targetPomPath, pomData);
      changes.push({
        task: task.id,
        pomPath: targetPomPath,
        timestamp: new Date().toISOString(),
        type: "upgrade",
        before: component.currentVersion,
        after: component.targetVersion,
      });
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
          error:
            "exclude-and-replace requires ownerGroupId and ownerArtifactId in task metadata",
        };
      }

      // Step 1: Add exclusion to the owning dependency
      const excluded = pomWorker.addExclusion(
        pomData,
        ownerG,
        ownerA,
        component.groupId,
        component.artifactId,
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
      } else {
        return {
          success: false,
          changes: [],
          error: `Dependency ${component.groupId}:${component.artifactId} not found in POM dependencies`,
        };
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
