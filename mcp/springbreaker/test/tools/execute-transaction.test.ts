import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY } from "../../src/config.js";
import { planStore } from "../../src/store.js";
import type { ExecutionPlan, RemediationTask } from "../../src/types/index.js";

const verifyResults = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../src/workers/maven-worker.js", () => ({
  MavenWorker: vi.fn().mockImplementation(() => ({
    cleanVerify: vi.fn().mockImplementation(async () => {
      const success = verifyResults.calls++ === 0;
      return {
        exitCode: success ? 0 : 1,
        stdout: success ? "BUILD SUCCESS" : "BUILD FAILURE",
        stderr: success ? "" : "compilation failed",
        duration: 1,
        success,
      };
    }),
  })),
}));

vi.mock("../../src/workers/git-worker.js", () => ({
  GitWorker: vi.fn().mockImplementation(() => ({
    isGitRepo: vi.fn().mockResolvedValue(false),
  })),
}));

function task(pomPath: string, artifactId: string, targetVersion: string, dependencies: string[] = []): RemediationTask {
  return {
    id: randomUUID(),
    priority: "apply-iq-suggestion",
    description: `Upgrade ${artifactId}`,
    component: {
      groupId: "org.example",
      artifactId,
      currentVersion: "1.0.0",
      targetVersion,
    },
    reason: "test",
    expectedFixes: [],
    expectedVulnerabilities: [],
    confidence: "high",
    risk: "low",
    preconditions: [],
    verification: [],
    rollbackSteps: [],
    dependencies,
    status: "pending",
    pomPath,
  };
}

describe("execute_plan batch transactions", () => {
  let projectPath: string;

  beforeEach(async () => {
    planStore.clear();
    verifyResults.calls = 0;
    projectPath = await realpath(await mkdtemp(join(tmpdir(), "springbreaker-transaction-")));
    await writeFile(join(projectPath, "pom.xml"), `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.example</groupId><artifactId>app</artifactId><version>1.0.0</version>
  <dependencies>
    <dependency><groupId>org.example</groupId><artifactId>first</artifactId><version>1.0.0</version></dependency>
    <dependency><groupId>org.example</groupId><artifactId>second</artifactId><version>1.0.0</version></dependency>
  </dependencies>
</project>`, "utf-8");
  });

  afterEach(async () => {
    planStore.clear();
    await rm(projectPath, { recursive: true, force: true });
  });

  it("preserves a verified earlier batch when a later batch fails", async () => {
    const pomPath = join(projectPath, "pom.xml");
    const first = task(pomPath, "first", "1.0.1");
    const second = task(pomPath, "second", "1.0.2", [first.id]);
    const plan: ExecutionPlan = {
      id: randomUUID(),
      projectId: "test-app",
      projectPath,
      tasks: [first, second],
      batches: [[first], [second]],
      estimatedDuration: "2 minutes",
      riskAssessment: "low",
      summary: "transaction test",
      createdAt: new Date().toISOString(),
      policyUsed: { ...DEFAULT_POLICY, verifyIq: false },
      vulnerabilitiesBySeverity: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
      vulnerabilityIds: [],
      vulnerabilityOccurrences: [],
      planningIssues: [],
      gitRevision: "",
      projectFingerprint: "",
      policyHash: "",
    };
    planStore.savePlan(plan);
    const { executePlan } = await import("../../src/tools/execute-plan.js");

    const response = await executePlan({
      projectPath,
      planId: plan.id,
      approveAll: true,
      dryRun: false,
      commit: false,
      createBranch: false,
    });
    const result = JSON.parse(response.content[0].text);
    const pom = await readFile(pomPath, "utf-8");

    expect(result.status).toBe("partial");
    expect(result.tasksCompleted).toBe(1);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "BUILD_FAILED", rollbackSuccess: true }),
    ]));
    expect(pom).toContain("<artifactId>first</artifactId>");
    expect(pom).toContain("<version>1.0.1</version>");
    expect(pom).toContain("<artifactId>second</artifactId>");
    expect(pom).not.toContain("<version>1.0.2</version>");
  });

  it("claims non-dry-run plans exactly once", async () => {
    const pomPath = join(projectPath, "pom.xml");
    const first = task(pomPath, "first", "1.0.1");
    const plan: ExecutionPlan = {
      id: randomUUID(), projectId: "test-app", projectPath, tasks: [first], batches: [[first]],
      estimatedDuration: "1 minute", riskAssessment: "low", summary: "single use",
      createdAt: new Date().toISOString(), policyUsed: { ...DEFAULT_POLICY, verifyIq: false },
      vulnerabilitiesBySeverity: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
      vulnerabilityIds: [], vulnerabilityOccurrences: [], planningIssues: [],
      gitRevision: "", projectFingerprint: "", policyHash: "",
    };
    planStore.savePlan(plan);
    const { executePlan } = await import("../../src/tools/execute-plan.js");
    const args = { projectPath, planId: plan.id, approveAll: true, dryRun: false, commit: false, createBranch: false };

    await executePlan(args);
    const secondResult = await executePlan(args);
    const error = JSON.parse(secondResult.content[0].text);
    expect(error.message).toContain("already been executed");
  });
});
