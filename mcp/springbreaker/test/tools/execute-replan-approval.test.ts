import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY } from "../../src/config.js";
import { planStore } from "../../src/store.js";
import type { ExecutionPlan, RemediationTask } from "../../src/types/index.js";

vi.mock("../../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/config.js")>("../../src/config.js");
  return {
    ...actual,
    loadEnvConfig: vi.fn().mockReturnValue({
      iqServerUrl: "https://iq.example.test",
      iqServerToken: "test-token",
      iqAppId: "test-app",
      iqUsername: "service-account",
      nexusUrl: "https://nexus.example.test",
      nexusUsername: "",
      nexusPassword: "",
      preferMvnw: false,
      mavenOpts: undefined,
      logLevel: "error",
      mavenEnvAllowlist: [],
      allowInsecureHttp: false,
    }),
  };
});

vi.mock("../../src/workers/maven-worker.js", () => ({
  MavenWorker: vi.fn().mockImplementation(() => ({
    checkMavenAvailable: vi.fn().mockResolvedValue(true),
    getJavaVersion: vi.fn().mockResolvedValue("21"),
    cleanVerify: vi.fn().mockResolvedValue({
      exitCode: 0, stdout: "BUILD SUCCESS", stderr: "", duration: 1, success: true,
    }),
    getDependencyTree: vi.fn().mockResolvedValue(
      "[INFO] org.example:app:jar:1.0.0\n" +
      "[INFO] +- org.example:first:jar:1.0.1:compile\n" +
      "[INFO] \\- org.example:second:jar:1.0.0:compile",
    ),
    analyzeUnusedDependencies: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("../../src/workers/iq-worker.js", () => ({ IQWorker: vi.fn() }));
vi.mock("../../src/workers/git-worker.js", () => ({
  GitWorker: vi.fn().mockImplementation(() => ({
    isGitRepo: vi.fn().mockResolvedValue(false),
  })),
}));

vi.mock("../../src/tools/iq-scan.js", () => ({
  scanProjectWithIq: vi.fn().mockResolvedValue({
    reportId: "after-first-batch",
    applicationId: "test-app",
    scanId: "scan-2",
    scanTime: "2026-01-01T00:00:00Z",
    components: [{
      packageUrl: "pkg:maven/org.example/second@1.0.0",
      displayName: "org.example:second:1.0.0",
      version: "1.0.0",
      groupId: "org.example",
      artifactId: "second",
      extension: "jar",
      vulnerabilities: [{
        id: "CVE-SECOND",
        referenceUrl: "https://example.test/CVE-SECOND",
        description: "second finding",
        severity: "HIGH",
        cvssScore: 8,
        CWEs: [],
        licenseRisk: false,
        componentDisplayName: "org.example:second:1.0.0",
        pathNames: [],
        suggestedVersion: "1.0.2",
        fixVersions: ["1.0.2"],
        firstPublished: "2026-01-01",
        lastModified: "2026-01-01",
      }],
    }],
    totalVulnerabilities: 1,
    vulnerabilitiesBySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
  }),
}));

function remediationTask(
  pomPath: string,
  artifactId: string,
  targetVersion: string,
  vulnerabilityId: string,
  dependencies: string[] = [],
): RemediationTask {
  return {
    id: randomUUID(),
    priority: "apply-iq-suggestion",
    description: `Upgrade ${artifactId}`,
    component: { groupId: "org.example", artifactId, currentVersion: "1.0.0", targetVersion },
    reason: "IQ remediation",
    expectedFixes: [vulnerabilityId],
    expectedVulnerabilities: [{
      groupId: "org.example", artifactId, version: "1.0.0", vulnerabilityId,
    }],
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

describe("execute_plan adaptive approval boundary", () => {
  let projectPath: string;

  beforeEach(async () => {
    planStore.clear();
    projectPath = await realpath(await mkdtemp(join(tmpdir(), "springbreaker-replan-")));
    await writeFile(join(projectPath, "pom.xml"), `<?xml version="1.0"?>
<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>app</artifactId><version>1.0.0</version>
<dependencies>
<dependency><groupId>org.example</groupId><artifactId>first</artifactId><version>1.0.0</version></dependency>
<dependency><groupId>org.example</groupId><artifactId>second</artifactId><version>1.0.0</version></dependency>
</dependencies></project>`, "utf-8");
  });

  afterEach(async () => {
    planStore.clear();
    await rm(projectPath, { recursive: true, force: true });
  });

  it("pauses and returns a fresh plan when replanning changes an approved action", async () => {
    const pomPath = join(projectPath, "pom.xml");
    const first = remediationTask(pomPath, "first", "1.0.1", "CVE-FIRST");
    const second = remediationTask(pomPath, "second", "1.0.1", "CVE-SECOND", [first.id]);
    const plan: ExecutionPlan = {
      id: randomUUID(), projectId: "test-app", projectPath,
      tasks: [first, second], batches: [[first], [second]],
      estimatedDuration: "2 minutes", riskAssessment: "medium", summary: "replan approval",
      createdAt: new Date().toISOString(),
      policyUsed: { ...DEFAULT_POLICY, removeUnused: false },
      vulnerabilitiesBySeverity: { total: 2, critical: 0, high: 2, medium: 0, low: 0 },
      vulnerabilityIds: ["CVE-FIRST", "CVE-SECOND"],
      vulnerabilityOccurrences: [
        { groupId: "org.example", artifactId: "first", version: "1.0.0", vulnerabilityId: "CVE-FIRST" },
        { groupId: "org.example", artifactId: "second", version: "1.0.0", vulnerabilityId: "CVE-SECOND" },
      ],
      planningIssues: [], gitRevision: "", projectFingerprint: "", policyHash: "",
    };
    planStore.savePlan(plan);
    const { executePlan } = await import("../../src/tools/execute-plan.js");

    const response = await executePlan({
      projectPath, planId: plan.id, approveAll: true, dryRun: false, commit: false, createBranch: false,
    });
    const result = JSON.parse(response.content[0].text);
    const pom = await readFile(pomPath, "utf-8");

    expect(result.status).toBe("partial");
    expect(result.continuationPlanId).toEqual(expect.any(String));
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "APPROVAL_REQUIRED" }));
    expect(planStore.getPlan(result.continuationPlanId)).toBeDefined();
    expect(pom).toContain("<artifactId>first</artifactId>");
    expect(pom).toContain("<version>1.0.1</version>");
    expect(pom).not.toContain("<version>1.0.2</version>");
  });
});
