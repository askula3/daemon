import { describe, it, expect, beforeEach } from "vitest";
import { Planner } from "../../src/engine/planner.js";
import { PolicyEngine } from "../../src/engine/policy-engine.js";
import { DependencyGraphBuilder } from "../../src/engine/dependency-graph.js";
import { DEFAULT_POLICY } from "../../src/config.js";
import type { Component, Vulnerability } from "../../src/types/index.js";

function makeVuln(overrides: Partial<Vulnerability> = {}): Vulnerability {
  return {
    id: "vuln-1",
    referenceUrl: "http://example.com",
    description: "Test vulnerability",
    severity: "HIGH",
    cvssScore: 8.0,
    CWEs: [],
    licenseRisk: false,
    componentDisplayName: "test:lib:1.0.0",
    pathNames: [],
    fixVersions: ["1.0.1"],
    firstPublished: "2024-01-01",
    lastModified: "2024-01-01",
    ...overrides,
  };
}

function makeComponent(overrides: Partial<Component> = {}): Component {
  return {
    packageUrl: "pkg:maven/com.example/lib@1.0.0",
    displayName: "com.example:lib:1.0.0",
    version: "1.0.0",
    groupId: "com.example",
    artifactId: "lib",
    extension: "jar",
    vulnerabilities: [makeVuln()],
    ...overrides,
  };
}

describe("Planner", () => {
  let planner: Planner;
  let policyEngine: PolicyEngine;
  let graphBuilder: DependencyGraphBuilder;

  beforeEach(() => {
    policyEngine = new PolicyEngine(DEFAULT_POLICY);
    graphBuilder = new DependencyGraphBuilder();

    // Build a simple graph
    const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.example:lib:jar:1.0.0:compile
[INFO] |  +- com.example:transitive:jar:1.0.0:compile
[INFO] +- org.apache.commons:commons-lang3:jar:3.12.0:compile`;

    graphBuilder.buildFromMavenTree(treeOutput);

    planner = new Planner(policyEngine, graphBuilder);
  });

  describe("createPlan", () => {
    it("should create a plan with tasks", async () => {
      const components = [
        makeComponent(),
      ];

      const plan = await planner.createPlan(components, "test-project");

      expect(plan.id).toBeDefined();
      expect(plan.projectId).toBe("test-project");
      expect(plan.tasks.length).toBe(1);
      expect(plan.batches.length).toBeGreaterThan(0);
      expect(plan.createdAt).toBeDefined();
      expect(plan.policyUsed).toBeDefined();
    });

    it("should create multiple tasks for multiple components", async () => {
      const components = [
        makeComponent(),
        makeComponent({
          packageUrl: "pkg:maven/com.example/other@2.0.0",
          groupId: "com.example",
          artifactId: "other",
          version: "2.0.0",
          vulnerabilities: [makeVuln({ id: "vuln-2" })],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      expect(plan.tasks.length).toBe(2);
    });

    it("should skip components with no valid target version", async () => {
      const components = [
        makeComponent({
          vulnerabilities: [
            makeVuln({ fixVersions: [], suggestedVersion: undefined }),
          ],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      expect(plan.tasks.length).toBe(0);
    });

    it("should include risk assessment", async () => {
      const components = [makeComponent()];
      const plan = await planner.createPlan(components, "test-project");

      expect(["low", "medium", "high"]).toContain(plan.riskAssessment);
    });

    it("should include estimated duration", async () => {
      const components = [makeComponent()];
      const plan = await planner.createPlan(components, "test-project");

      expect(plan.estimatedDuration).toBeDefined();
      expect(typeof plan.estimatedDuration).toBe("string");
    });
  });

  describe("batch building", () => {
    it("should put independent tasks in the same batch", async () => {
      const components = [
        makeComponent(),
        makeComponent({
          packageUrl: "pkg:maven/com.example/other@2.0.0",
          groupId: "com.example",
          artifactId: "other",
          version: "2.0.0",
          vulnerabilities: [makeVuln({ id: "vuln-2" })],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      // Independent tasks should be in the same batch (first batch)
      if (plan.batches.length > 0) {
        expect(plan.batches[0].length).toBe(2);
      }
    });

    it("should handle empty components", async () => {
      const plan = await planner.createPlan([], "test-project");

      expect(plan.tasks.length).toBe(0);
      expect(plan.batches.length).toBe(0);
    });
  });

  describe("task creation", () => {
    it("should set correct priority for direct dependencies", async () => {
      const components = [makeComponent()];

      const plan = await planner.createPlan(components, "test-project");

      expect(plan.tasks[0].priority).toBe("upgrade-owning-direct-dependency");
    });

    it("should include expectedFixes from vulnerabilities", async () => {
      const components = [
        makeComponent({
          vulnerabilities: [
            makeVuln({ id: "vuln-1" }),
            makeVuln({ id: "vuln-2", severity: "MEDIUM", cvssScore: 5.0 }),
          ],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      expect(plan.tasks[0].expectedFixes).toContain("vuln-1");
      expect(plan.tasks[0].expectedFixes).toContain("vuln-2");
    });

    it("should use IQ suggested version when available", async () => {
      const components = [
        makeComponent({
          packageUrl: "pkg:maven/com.example/lib@1.0.0",
          groupId: "com.example",
          artifactId: "lib",
          vulnerabilities: [
            makeVuln({ suggestedVersion: "1.0.5", fixVersions: ["1.0.1"] }),
          ],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      expect(plan.tasks[0].component.targetVersion).toBe("1.0.5");
    });
  });
});
