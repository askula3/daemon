import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { loadEnvConfig } from "../config.js";
import { POMWorker } from "../workers/pom-worker.js";
import { MavenWorker } from "../workers/maven-worker.js";
import { GitWorker } from "../workers/git-worker.js";
import type { ProjectInfo, ProjectCapabilities } from "../types/index.js";
import { mavenLimit } from "../utils/concurrency.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("ProjectInfo");

export async function analyzeProjectUsage(
  projectInfo: ProjectInfo,
  mavenWorker: MavenWorker,
  timeout?: number,
  signal?: AbortSignal,
): Promise<void> {
  const pomPaths = [...new Set(projectInfo.dependencyDeclarations
    .filter((declaration) => declaration.kind === "dependency")
    .map((declaration) => declaration.pomPath))];
  const results = await Promise.all(pomPaths.map((pomPath) => mavenLimit(async () => {
    try {
      const dependencies = await mavenWorker.analyzeUnusedDependencies(
        projectInfo.projectPath,
        pomPath,
        { timeout, signal },
      );
      return dependencies.map((dependency) => ({ ...dependency, pomPath }));
    } catch (error) {
      if (signal?.aborted) throw error;
      // Usage remains unknown. Never classify a dependency as unused when
      // Maven analysis is unavailable or fails.
      log.warn(`Dependency usage analysis failed for ${pomPath}: ${error}`);
      return [];
    }
  })));
  projectInfo.unusedDependencyDeclarations = results.flat();
}

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
  inspectRuntime: boolean = true,
): Promise<ProjectInfo> {
  const rootPomPath = `${projectPath}/pom.xml`;
  const rootPomContent = await pomWorker.readPomContent(rootPomPath);
  const rootPomData = await pomWorker.readPom(rootPomPath);
  const pomFiles = await pomWorker.findPomFiles(projectPath);
  const fingerprintFiles: Record<string, string> = {};
  const dependencyDeclarations: ProjectInfo["dependencyDeclarations"] = [];
  for (const pomPath of pomFiles) {
    fingerprintFiles[relative(projectPath, pomPath)] =
      await pomWorker.readPomContent(pomPath);
    const pomData = await pomWorker.readPom(pomPath);
    for (const dependency of pomWorker.extractDependencies(pomData)) {
      dependencyDeclarations.push({
        groupId: dependency.groupId,
        artifactId: dependency.artifactId,
        pomPath,
        kind: "dependency",
      });
    }
    for (const dependency of pomWorker.extractDependencyManagement(pomData)) {
      dependencyDeclarations.push({
        groupId: dependency.groupId,
        artifactId: dependency.artifactId,
        pomPath,
        kind: "dependency-management",
      });
    }
  }
  for (const relativePath of [
    "mvnw",
    "mvnw.cmd",
    ".mvn/wrapper/maven-wrapper.properties",
    ".remediation-policy.json",
  ]) {
    const absolutePath = `${projectPath}/${relativePath}`;
    if (existsSync(absolutePath)) {
      fingerprintFiles[relativePath] = await readFile(absolutePath, "utf-8");
    }
  }
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
    hasIQConfig: !!envConfig.iqServerToken && !!envConfig.iqAppId,
    hasNexusConfig: !!envConfig.nexusUsername,
  };

  // Get git branch, revision, and working-tree status
  let gitBranch = "unknown";
  let gitRevision = "unknown";
  let isClean = false;
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
      isClean = status.isClean;
      modifiedFiles = status.changed;
    } catch {
      // Ignore git errors
    }
  }

  // Get Spring Boot version
  let springBootVersion = pomWorker.extractSpringBootVersion(rootPomData);
  let springBootVersionSource: ProjectInfo["springBootVersionSource"] = null;
  let springBootVersionProperty: string | null = null;
  for (const propertyName of ["spring-boot.version", "spring.boot.version"]) {
    if (projectInfo.properties[propertyName]) {
      springBootVersionSource = "property";
      springBootVersionProperty = propertyName;
      break;
    }
  }
  if (
    !springBootVersion &&
    projectInfo.parent?.artifactId === "spring-boot-starter-parent"
  ) {
    springBootVersion = projectInfo.parent.version;
  }
  if (projectInfo.parent?.artifactId === "spring-boot-starter-parent") {
    springBootVersionSource = "parent";
  } else if (!springBootVersionSource) {
    const bootBom = dependencyManagement.find(
      (entry) => entry.groupId === "org.springframework.boot" &&
        entry.artifactId === "spring-boot-dependencies",
    );
    if (bootBom) {
      springBootVersion = bootBom.version;
      springBootVersionSource = "dependency-management";
    }
  }

  // Get Java version
  let javaVersion = "unknown";
  if (capabilities.hasMaven && inspectRuntime) {
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
    fingerprintFiles,
    modules: projectInfo.modules,
    javaVersion,
    springBootVersion,
    springBootVersionSource,
    springBootVersionProperty,
    springBootParentVersion: projectInfo.parent?.version || null,
    parentGroupId: projectInfo.parent?.groupId || null,
    parentArtifactId: projectInfo.parent?.artifactId || null,
    parentVersion: projectInfo.parent?.version || null,
    dependencyManagement,
    dependencyDeclarations,
    unusedDependencyDeclarations: [],
    capabilities,
    timestamp: new Date().toISOString(),
  };
}
