import { z } from "zod";
import { createChildLogger } from "../utils/logger.js";
import { handleToolError } from "../utils/errors.js";
import { withProjectLock } from "../utils/lock.js";
import { loadEnvConfig } from "../config.js";
import { MavenWorker } from "../workers/maven-worker.js";
import { IQWorker } from "../workers/iq-worker.js";
import { VerifySchema } from "./schemas.js";

const log = createChildLogger("Verify");

// Tool: verify
export async function verify(args: z.infer<typeof VerifySchema>): Promise<{
  content: { type: "text"; text: string }[];
}> {
  return withProjectLock(args.projectPath, async () => {
    try {
      const { projectPath } = args;
      log.info(`Verifying project: ${projectPath}`);

      const envConfig = loadEnvConfig(projectPath);
      const mavenWorker = new MavenWorker(
        envConfig.preferMvnw,
        envConfig.mavenOpts,
      );

      // Run clean verify
      const buildResult = await mavenWorker.cleanVerify(projectPath);

      // Run IQ scan if configured
      let iqResult = null;
      if (envConfig.iqServerToken) {
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                buildSuccess: buildResult.success,
                buildOutput: buildResult.stdout.slice(-1000),
                iqScanResult: iqResult
                  ? {
                      totalVulnerabilities: iqResult.totalVulnerabilities,
                      vulnerabilitiesBySeverity:
                        iqResult.vulnerabilitiesBySeverity,
                    }
                  : null,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return handleToolError(error);
    }
  });
}
