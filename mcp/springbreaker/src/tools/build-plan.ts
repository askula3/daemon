import { z } from "zod";
import { createChildLogger } from "../utils/logger.js";
import { handleToolError } from "../utils/errors.js";
import { withProjectLock } from "../utils/lock.js";
import { loadEnvConfig, loadPolicyConfig } from "../config.js";
import { POMWorker } from "../workers/pom-worker.js";
import { MavenWorker } from "../workers/maven-worker.js";
import { GitWorker } from "../workers/git-worker.js";
import { IQWorker } from "../workers/iq-worker.js";
import { NexusWorker } from "../workers/nexus-worker.js";
import { PolicyEngine } from "../engine/policy-engine.js";
import { DependencyGraphBuilder } from "../engine/dependency-graph.js";
import { Planner } from "../engine/planner.js";
import { planStore } from "../store.js";
import { BuildPlanSchema } from "./schemas.js";
import { buildProjectInfo } from "./project-info.js";
import { computeProjectFingerprint, computePolicyHash } from "../utils/hash.js";

const log = createChildLogger("BuildPlan");

// Tool: build_plan
export async function buildPlan(
  args: z.infer<typeof BuildPlanSchema>,
): Promise<{
  content: { type: "text"; text: string }[];
}> {
  return withProjectLock(args.projectPath, async () => {
    try {
      const { projectPath, severity, policy: policyOverrides } = args;
      log.info(`Building plan for: ${projectPath}`);

      // Load configuration
      const envConfig = loadEnvConfig(projectPath);
      const policyConfig = loadPolicyConfig(projectPath);

      // Apply severity overrides
      if (severity) {
        policyConfig.severity = severity;
      }

      // Apply policy overrides
      if (policyOverrides) {
        Object.assign(policyConfig, policyOverrides);
      }

      // Initialize workers
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
      const nexusWorker = envConfig.nexusUsername
        ? new NexusWorker(
            envConfig.nexusUrl,
            envConfig.nexusUsername,
            envConfig.nexusPassword,
          )
        : null;

      // Get project info using shared helper
      const projectInfo = await buildProjectInfo(
        projectPath, pomWorker, mavenWorker, gitWorker, envConfig,
      );

      // Get dependency tree
      const treeOutput = await mavenWorker.getDependencyTree(projectPath);

      // Build dependency graph
      const graphBuilder = new DependencyGraphBuilder();
      graphBuilder.buildFromMavenTree(treeOutput);
      graphBuilder.markSpringBootManaged(projectInfo);
      graphBuilder.markDependencyManagement(projectInfo.dependencyManagement);

      // Get IQ report (iqWorker is null when token is not configured)
      let iqReport = null;
      if (iqWorker) {
        try {
          iqReport = await iqWorker.scanAndGetReport(envConfig.iqAppId);
          graphBuilder.markVulnerableComponents(iqReport);
        } catch (error) {
          log.warn(`Failed to get IQ report: ${error}`);
        }
      }

      // Create policy engine
      const policyEngine = new PolicyEngine(policyConfig);

      // Create planner with Nexus worker for version lookups
      const planner = new Planner(policyEngine, graphBuilder, nexusWorker);

      // Get vulnerable components
      const vulnerableComponents = iqReport
        ? policyEngine.filterComponentsByPolicy(iqReport.components)
        : [];

      // Create plan
      const plan = await planner.createPlan(vulnerableComponents, envConfig.iqAppId, projectInfo);

      // Add plan immutability fields (spec §21)
      plan.gitRevision = projectInfo.gitRevision;
      plan.projectFingerprint = computeProjectFingerprint(
        projectInfo.rootPomContent,
        projectInfo.modules,
        projectInfo.dependencyManagement,
      );
      plan.policyHash = computePolicyHash(policyConfig as unknown as Record<string, unknown>);

      // Persist plan so execute_plan can look it up by ID
      planStore.savePlan(plan);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(plan, null, 2),
          },
        ],
      };
    } catch (error) {
      return handleToolError(error);
    }
  });
}
