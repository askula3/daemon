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

const log = createChildLogger("InspectProject");

// Tool: inspect_project
export async function inspectProject(
  args: z.infer<typeof InspectProjectSchema>,
): Promise<{
  content: { type: "text"; text: string }[];
}> {
  return withProjectLock(args.projectPath, async () => {
    try {
      const { projectPath } = args;
      log.info(`Inspecting project: ${projectPath}`);

      const envConfig = loadEnvConfig(projectPath);
      const pomWorker = new POMWorker();
      const mavenWorker = new MavenWorker(
        envConfig.preferMvnw,
        envConfig.mavenOpts,
      );
      const gitWorker = new GitWorker();

      const result = await buildProjectInfo(
        projectPath, pomWorker, mavenWorker, gitWorker, envConfig,
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
      return handleToolError(error);
    }
  });
}
