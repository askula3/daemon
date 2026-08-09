import { z } from "zod";
import { createChildLogger } from "../utils/logger.js";
import { handleToolError } from "../utils/errors.js";
import { withProjectLock } from "../utils/lock.js";
import { loadEnvConfig } from "../config.js";
import { MavenWorker } from "../workers/maven-worker.js";
import { IQWorker } from "../workers/iq-worker.js";
import { planStore } from "../store.js";
import { VerifySchema } from "./schemas.js";

const log = createChildLogger("Verify");

// Tool: verify
export async function verify(args: z.infer<typeof VerifySchema>): Promise<{
  content: { type: "text"; text: string }[];
}> {
  return withProjectLock(args.projectPath, async () => {
    try {
      const { projectPath, skipBuild, skipIq, compareWithExecutionId } = args;
      log.info(`Verifying project: ${projectPath}`);

      const envConfig = loadEnvConfig(projectPath);

      // Run clean verify (unless skipped)
      let buildResult: { success: boolean; stdout: string; stderr: string } | null = null;
      if (!skipBuild) {
        const mavenWorker = new MavenWorker(
          envConfig.preferMvnw,
          envConfig.mavenOpts,
        );
        buildResult = await mavenWorker.cleanVerify(projectPath);
      }

      // Run IQ scan if configured and not skipped
      let iqResult = null;
      if (!skipIq && envConfig.iqServerToken) {
        const iqWorker = new IQWorker(
          envConfig.iqServerUrl,
          envConfig.iqServerToken,
          envConfig.iqAppId,
          envConfig.iqUsername,
        );
        try {
          iqResult = await iqWorker.scanAndGetReport(envConfig.iqAppId);
        } catch (error) {
          log.warn(`IQ scan failed: ${error}`);
        }
      }

      // Build response
      const response: Record<string, unknown> = {
        buildSuccess: buildResult?.success ?? null,
        buildSkipped: !!skipBuild,
        buildOutput: buildResult?.stdout.slice(-1000) ?? null,
        iqScanResult: iqResult
          ? {
              totalVulnerabilities: iqResult.totalVulnerabilities,
              vulnerabilitiesBySeverity: iqResult.vulnerabilitiesBySeverity,
            }
          : null,
        iqScanSkipped: !!skipIq,
      };

      // Before/after comparison (spec §31)
      if (compareWithExecutionId && iqResult) {
        const prevState = planStore.getExecution(compareWithExecutionId);
        if (prevState) {
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
            error: `Execution not found: ${compareWithExecutionId}`,
          };
        }
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
