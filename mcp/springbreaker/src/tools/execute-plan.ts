import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createChildLogger } from "../utils/logger.js";
import { handleToolError, POMError } from "../utils/errors.js";
import { withProjectLock } from "../utils/lock.js";
import { loadEnvConfig } from "../config.js";
import { POMWorker } from "../workers/pom-worker.js";
import { MavenWorker } from "../workers/maven-worker.js";
import { GitWorker } from "../workers/git-worker.js";
import { IQWorker } from "../workers/iq-worker.js";
import { planStore } from "../store.js";
import { ExecutePlanSchema } from "./schemas.js";
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
      const { projectPath, planId, approvedTasks } = args;
      log.info(`Executing plan ${planId} for: ${projectPath}`);

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
      const changes: ChangeRecord[] = [];
      const errors: ErrorRecord[] = [];
      const pomBackups = new Map<string, string>();
      const completedTaskIds = new Set<string>();

      // Determine which tasks to execute
      const tasksToRun =
        approvedTasks && approvedTasks.length > 0
          ? plan.tasks.filter((t) => approvedTasks.includes(t.id))
          : plan.tasks;

      const startedAt = new Date().toISOString();
      let tasksCompleted = 0;
      let tasksFailed = 0;
      let tasksSkipped = 0;

      try {
        // Create feature branch for safe rollback
        await gitWorker.init(projectPath);
        const branchName = `springbreaker/remediation-${executionId.slice(0, 8)}`;

        try {
          await gitWorker.createBranch(projectPath, branchName);
          log.info(`Created branch: ${branchName}`);
        } catch (error) {
          log.warn(`Could not create branch (continuing on current): ${error}`);
        }

        // Create POM backups BEFORE any modifications
        // Back up ALL POM files (root + modules) for safe rollback
        const allPomFiles = await pomWorker.findPomFiles(projectPath);
        for (const pomPath of allPomFiles) {
          try {
            const backupPath = await pomWorker.backupPom(pomPath);
            pomBackups.set(pomPath, backupPath);
            log.info(`POM backup created: ${backupPath}`);
          } catch (error) {
            log.error(`Failed to create POM backup for ${pomPath}: ${error}`);
            throw new POMError(
              `Cannot proceed without POM backup for ${pomPath}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        // Execute tasks in batches — build verification happens per-batch, not per-task
        for (const batch of plan.batches) {
          const batchTasks = batch.filter((t) =>
            tasksToRun.some((r) => r.id === t.id),
          );

          if (batchTasks.length === 0) continue;

          // Phase 1: Execute all tasks in this batch
          const batchChanges: ChangeRecord[] = [];

          for (const task of batchTasks) {
            // Check if dependencies are satisfied
            const depsSatisfied = task.dependencies.every((dep) =>
              completedTaskIds.has(dep),
            );
            if (!depsSatisfied) {
              log.warn(`Skipping task ${task.id} — dependencies not satisfied`);
              task.status = "skipped";
              tasksSkipped++;
              continue;
            }

            try {
              task.status = "in-progress";
              log.info(`Executing task: ${task.description}`);

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
              log.error(`Task ${task.id} failed: ${errMsg}`);
            }
          }

          // Phase 2: Verify build for the entire batch (not per-task)
          if (batchChanges.length > 0 && plan.policyUsed.verifyBuild) {
            const buildResult = await mavenWorker.cleanVerify(projectPath);
            if (!buildResult.success) {
              log.warn(`Batch build failed — rolling back batch`);
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
                  log.error(`No backup for ${pomPath}`);
                  rollbackOk = false;
                  continue;
                }
                try {
                  await pomWorker.restorePom(backupPath, pomPath);
                } catch {
                  log.error(`Failed to restore ${pomPath}`);
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
              });
              continue;
            }
          }

          // Phase 3: Batch succeeded — commit changes and update counters
          changes.push(...batchChanges);
          for (const task of batchTasks) {
            if (task.status === "completed") {
              completedTaskIds.add(task.id);
              tasksCompleted++;
            }
          }
        }

        // Commit all changes
        if (changes.length > 0) {
          try {
            await gitWorker.add(projectPath, ".");
            await gitWorker.commit(
              projectPath,
              `springbreaker: remediate ${tasksCompleted} vulnerabilities (${executionId.slice(0, 8)})`,
            );
            log.info("Changes committed");
          } catch (error) {
            log.warn(`Could not commit changes: ${error}`);
          }
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
            log.warn(`IQ rescan failed: ${error}`);
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
            log.error(`Failed to restore ${pomPath} from ${backupPath}`);
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
      return {
        success: false,
        changes: [],
        error: "exclude-and-replace not yet implemented",
      };
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
