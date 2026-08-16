import { z } from "zod";
import { createChildLogger } from "../utils/logger.js";
import { handleToolError } from "../utils/errors.js";
import { withProjectLock } from "../utils/lock.js";
import { loadEnvConfig } from "../config.js";
import { POMWorker } from "../workers/pom-worker.js";
import { MavenWorker } from "../workers/maven-worker.js";
import { GitWorker } from "../workers/git-worker.js";
import { InspectProjectSchema } from "./schemas.js";
import { buildProjectInfo } from "./project-info.js";
import { resolveProjectPath } from "../utils/project-path.js";
import type { ToolContext } from "./context.js";

const log = createChildLogger("InspectProject");

// Tool: inspect_project
export async function inspectProject(
  args: z.infer<typeof InspectProjectSchema>,
  _context?: ToolContext,
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
      log.info(`Inspecting project: ${projectPath}`);

      const envConfig = loadEnvConfig(projectPath);
      const pomWorker = new POMWorker();
      const mavenWorker = new MavenWorker(
        envConfig.preferMvnw,
        envConfig.mavenOpts,
        envConfig.mavenEnvAllowlist,
      );
      const gitWorker = new GitWorker();

      const result = await buildProjectInfo(
        projectPath,
        pomWorker,
        mavenWorker,
        gitWorker,
        envConfig,
        false,
      );

      // Add capability-aware recommendations
      const recommendations: string[] = [];
      if (!result.capabilities.hasIQConfig) {
        recommendations.push(
          "No IQ Server configured — vulnerability scanning is disabled. Set IQ_SERVER_TOKEN and IQ_APP_ID in .env to enable.",
        );
      }
      if (!result.capabilities.hasNexusConfig) {
        recommendations.push(
          "No Nexus Repository configured — version resolution will use Maven Central (search.maven.org) as fallback.",
        );
      }
      if (!result.capabilities.hasMaven) {
        recommendations.push(
          "Maven not found on PATH — install Maven or ensure the Maven wrapper (mvnw) is present and executable.",
        );
      }
      if (!result.capabilities.hasGit) {
        recommendations.push(
          "Not a Git repository — branch/commit/rollback features are unavailable. Initialize git for full functionality.",
        );
      }

      const response =
        recommendations.length > 0 ? { ...result, recommendations } : result;

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
