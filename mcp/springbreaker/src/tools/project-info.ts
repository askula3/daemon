import { existsSync } from "node:fs";
import { loadEnvConfig } from "../config.js";
import { POMWorker } from "../workers/pom-worker.js";
import { MavenWorker } from "../workers/maven-worker.js";
import { GitWorker } from "../workers/git-worker.js";
import type { ProjectInfo, ProjectCapabilities } from "../types/index.js";

/**
 * Build a ProjectInfo object from POM data and environment config.
 * Shared between inspectProject and buildPlan to avoid duplication.
 */
export async function buildProjectInfo(
  projectPath: string,
  pomWorker: POMWorker,
  mavenWorker: MavenWorker,
  gitWorker: GitWorker,
  envConfig: ReturnType<typeof loadEnvConfig>,
): Promise<ProjectInfo> {
  const rootPomPath = `${projectPath}/pom.xml`;
  const rootPomContent = await pomWorker.readPomContent(rootPomPath);
  const rootPomData = await pomWorker.readPom(rootPomPath);
  const projectInfo = pomWorker.extractProjectInfo(rootPomData);
  const dependencyManagement =
    pomWorker.extractDependencyManagement(rootPomData);

  // Detect capabilities
  const capabilities: ProjectCapabilities = {
    hasMaven: await mavenWorker.checkMavenAvailable(projectPath),
    hasMavenWrapper: existsSync(`${projectPath}/mvnw`),
    hasSpringBoot:
      !!projectInfo.parent &&
      projectInfo.parent.artifactId === "spring-boot-starter-parent",
    isMultiModule: projectInfo.modules.length > 0,
    hasGit: await gitWorker.isGitRepo(projectPath),
    hasIQConfig: !!envConfig.iqServerToken,
    hasNexusConfig: !!envConfig.nexusUsername,
  };

  // Get git branch, revision, and working-tree status
  let gitBranch = "unknown";
  let gitRevision = "unknown";
  let isClean = true;
  let modifiedFiles: string[] = [];
  if (capabilities.hasGit) {
    try {
      gitBranch = await gitWorker.getCurrentBranch(projectPath);
    } catch {
      // Ignore git errors
    }
    try {
      gitRevision = await gitWorker.getLastCommitHash(projectPath);
    } catch {
      // Ignore git errors
    }
    try {
      const status = await gitWorker.getStatus(projectPath);
      isClean =
        status.modified.length === 0 &&
        status.staged.length === 0 &&
        status.notAdded.length === 0;
      modifiedFiles = [
        ...status.modified,
        ...status.staged,
        ...status.notAdded,
      ];
    } catch {
      // Ignore git errors
    }
  }

  // Get Spring Boot version
  let springBootVersion = pomWorker.extractSpringBootVersion(rootPomData);
  if (
    !springBootVersion &&
    projectInfo.parent?.artifactId === "spring-boot-starter-parent"
  ) {
    springBootVersion = projectInfo.parent.version;
  }

  // Get Java version
  let javaVersion = "unknown";
  if (capabilities.hasMaven) {
    try {
      javaVersion = await mavenWorker.getJavaVersion(projectPath);
    } catch {
      // Ignore errors
    }
  }

  return {
    projectPath,
    gitBranch,
    gitRevision,
    isClean,
    modifiedFiles,
    applicationId: envConfig.iqAppId,
    rootPomPath,
    rootPomContent,
    modules: projectInfo.modules,
    javaVersion,
    springBootVersion,
    springBootParentVersion: projectInfo.parent?.version || null,
    parentGroupId: projectInfo.parent?.groupId || null,
    parentArtifactId: projectInfo.parent?.artifactId || null,
    parentVersion: projectInfo.parent?.version || null,
    dependencyManagement,
    capabilities,
    timestamp: new Date().toISOString(),
  };
}
