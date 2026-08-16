import { z } from "zod";
import { createChildLogger } from "../utils/logger.js";
import { handleToolError } from "../utils/errors.js";
import { withProjectLock } from "../utils/lock.js";
import { loadEnvConfig } from "../config.js";
import { MavenWorker } from "../workers/maven-worker.js";
import { IQWorker } from "../workers/iq-worker.js";
import { planStore } from "../store.js";
import { VerifySchema } from "./schemas.js";
import { resolveProjectPath } from "../utils/project-path.js";
import { scanProjectWithIq } from "./iq-scan.js";
import type { ToolContext } from "./context.js";

const log = createChildLogger("Verify");

// Tool: verify
export async function verify(args: z.infer<typeof VerifySchema>, context?: ToolContext): Promise<{
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
      const { skipBuild, skipIq, compareWithExecutionId } = args;
      log.info(`Verifying project: ${projectPath}`);

      const envConfig = loadEnvConfig(projectPath);

      // Run clean verify (unless skipped)
      let buildResult: { success: boolean; stdout: string; stderr: string } | null = null;
      if (!skipBuild) {
        await context?.progress?.(1, 2, "Running Maven clean verify");
        const mavenWorker = new MavenWorker(
          envConfig.preferMvnw,
          envConfig.mavenOpts,
          envConfig.mavenEnvAllowlist,
        );
        buildResult = await mavenWorker.cleanVerify(projectPath, false, { signal: context?.signal });
        context?.signal?.throwIfAborted();
      }

      // Run IQ scan if configured and not skipped
      let iqResult = null;
      let iqScanError: string | null = null;
      const hasIqConfig = !!envConfig.iqServerToken && !!envConfig.iqAppId;
      if (!skipIq && hasIqConfig) {
        const iqWorker = new IQWorker(
          envConfig.iqServerUrl,
          envConfig.iqServerToken,
          envConfig.iqAppId,
          envConfig.iqUsername,
          envConfig.allowInsecureHttp,
        );
        try {
          await context?.progress?.(2, 2, "Generating SBOM and scanning with IQ");
          const scanMavenWorker = new MavenWorker(
            envConfig.preferMvnw,
            envConfig.mavenOpts,
            envConfig.mavenEnvAllowlist,
          );
          iqResult = await scanProjectWithIq(
            projectPath,
            scanMavenWorker,
            iqWorker,
            300_000,
            context?.signal,
          );
        } catch (error) {
          if (context?.signal?.aborted) throw error;
          log.warn(`IQ scan failed: ${error}`);
          iqScanError = error instanceof Error ? error.message : String(error);
        }
      }

      // Build response
      const response: Record<string, unknown> = {
        buildSuccess: buildResult?.success ?? null,
        buildSkipped: !!skipBuild,
        buildOutput: buildResult?.stdout.slice(-1000) ?? null,
        buildError: buildResult && !buildResult.success ? buildResult.stderr.slice(-1000) : null,
        iqScanResult: iqResult
          ? {
              totalVulnerabilities: iqResult.totalVulnerabilities,
              vulnerabilitiesBySeverity: iqResult.vulnerabilitiesBySeverity,
            }
          : null,
        iqScanSuccess: iqResult !== null,
        iqScanSkipped: !!skipIq || !hasIqConfig,
        iqScanError,
      };

      // Before/after comparison (spec §31)
      if (compareWithExecutionId && iqResult) {
        const prevState = planStore.getExecution(compareWithExecutionId);
        if (prevState?.plan.projectPath === projectPath) {
          const before = prevState.result.vulnerabilitiesBySeverityAfter;
          const after = {
            total: iqResult.totalVulnerabilities,
            critical: iqResult.vulnerabilitiesBySeverity.CRITICAL,
            high: iqResult.vulnerabilitiesBySeverity.HIGH,
            medium: iqResult.vulnerabilitiesBySeverity.MEDIUM,
            low: iqResult.vulnerabilitiesBySeverity.LOW,
          };
          response.comparison = {
            executionId: compareWithExecutionId,
            before,
            after,
            delta: {
              total: after.total - before.total,
              critical: after.critical - before.critical,
              high: after.high - before.high,
              medium: after.medium - before.medium,
              low: after.low - before.low,
            },
          };
        } else {
          response.comparison = {
            error: `Execution not found for this project: ${compareWithExecutionId}`,
          };
        }
      } else if (compareWithExecutionId) {
        response.comparison = {
          error: "A successful IQ scan is required for comparison",
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    } catch (error) {
      return handleToolError(error);
    }
  });
}
