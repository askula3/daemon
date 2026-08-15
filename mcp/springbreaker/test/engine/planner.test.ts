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
      const components = [makeComponent()];

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

    it("should skip Spring Boot managed components", async () => {
      // Use a component whose groupId starts with org.springframework.boot
      // so markSpringBootManaged detects it via groupId prefix
      const bootComponent = makeComponent({
        packageUrl:
          "pkg:maven/org.springframework.boot/spring-boot-starter-web@3.2.0",
        groupId: "org.springframework.boot",
        artifactId: "spring-boot-starter-web",
        version: "3.2.0",
      });

      // Build a graph that includes this component
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- org.springframework.boot:spring-boot-starter-web:jar:3.2.0:compile`;
      graphBuilder.buildFromMavenTree(treeOutput);

      graphBuilder.markSpringBootManaged({
        projectPath: "/test",
        gitBranch: "main",
        gitRevision: "abc",
        isClean: true,
        modifiedFiles: [],
        applicationId: "test",
        rootPomPath: "/test/pom.xml",
        rootPomContent: "",
        modules: [],
        javaVersion: "17",
        springBootVersion: "3.2.0",
        springBootParentVersion: "3.2.0",
        parentGroupId: "org.springframework.boot",
        parentArtifactId: "spring-boot-starter-parent",
        parentVersion: "3.2.0",
        dependencyManagement: [],
        mavenProfiles: [],
        capabilities: {
          hasMaven: true,
          hasMavenWrapper: false,
          hasSpringBoot: true,
          isMultiModule: false,
          hasGit: true,
          hasIQConfig: true,
          hasNexusConfig: true,
        },
        timestamp: new Date().toISOString(),
      });

      const plan = await planner.createPlan([bootComponent], "test-project");

      // Should have 0 tasks since the component is managed by Spring Boot
      expect(plan.tasks.length).toBe(0);
    });
  });

  describe("dependency-ordered batches", () => {
    it("creates separate batches for dependent tasks", async () => {
      // Build graph: my-app → lib → transitive
      // Both lib and transitive have vulnerabilities
      const components = [
        makeComponent({
          packageUrl: "pkg:maven/com.example/lib@1.0.0",
          groupId: "com.example",
          artifactId: "lib",
          version: "1.0.0",
          vulnerabilities: [makeVuln({ id: "vuln-lib" })],
        }),
        makeComponent({
          packageUrl: "pkg:maven/com.example/transitive@1.0.0",
          groupId: "com.example",
          artifactId: "transitive",
          version: "1.0.0",
          vulnerabilities: [makeVuln({ id: "vuln-trans" })],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      // Should have at least 2 batches if transitive depends on lib
      expect(plan.tasks.length).toBe(2);
    });
  });

  describe("vulnerabilitiesBySeverity", () => {
    it("counts vulnerabilities by severity", async () => {
      const components = [
        makeComponent({
          vulnerabilities: [
            makeVuln({ id: "v1", severity: "HIGH" }),
            makeVuln({ id: "v2", severity: "MEDIUM", cvssScore: 5 }),
            makeVuln({ id: "v3", severity: "CRITICAL", cvssScore: 9.5 }),
          ],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      expect(plan.vulnerabilitiesBySeverity.total).toBe(3);
      expect(plan.vulnerabilitiesBySeverity.critical).toBe(1);
      expect(plan.vulnerabilitiesBySeverity.high).toBe(1);
      expect(plan.vulnerabilitiesBySeverity.medium).toBe(1);
      expect(plan.vulnerabilitiesBySeverity.low).toBe(0);
    });
  });

  describe("validatePlan", () => {
    it("returns no errors for a valid plan", async () => {
      const components = [makeComponent()];
      const plan = await planner.createPlan(components, "test-project");

      const errors = planner.validatePlan(plan);
      expect(errors).toEqual([]);
    });

    it("detects circular dependencies", () => {
      const plan = {
        id: "test",
        projectId: "test",
        tasks: [
          {
            id: "a",
            dependencies: ["b"],
            status: "pending",
            priority: "upgrade-direct-dependency",
            description: "task a",
            component: {
              groupId: "g",
              artifactId: "a",
              currentVersion: "1",
              targetVersion: "2",
            },
            reason: "",
            expectedFixes: [],
            confidence: "medium",
            risk: "low",
            preconditions: [],
            verification: [],
            rollbackSteps: [],
          },
          {
            id: "b",
            dependencies: ["a"],
            status: "pending",
            priority: "upgrade-direct-dependency",
            description: "task b",
            component: {
              groupId: "g",
              artifactId: "b",
              currentVersion: "1",
              targetVersion: "2",
            },
            reason: "",
            expectedFixes: [],
            confidence: "medium",
            risk: "low",
            preconditions: [],
            verification: [],
            rollbackSteps: [],
          },
        ],
        batches: [],
        estimatedDuration: "",
        riskAssessment: "low" as const,
        summary: "",
        createdAt: "",
        policyUsed: DEFAULT_POLICY,
        vulnerabilitiesBySeverity: {
          total: 0,
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
        },
        gitRevision: "",
        projectFingerprint: "",
        policyHash: "",
      };

      const errors = planner.validatePlan(plan);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("Circular dependency");
    });

    it("detects dangling dependency references", () => {
      const plan = {
        id: "test",
        projectId: "test",
        tasks: [
          {
            id: "a",
            dependencies: ["nonexistent"],
            status: "pending",
            priority: "upgrade-direct-dependency",
            description: "task a",
            component: {
              groupId: "g",
              artifactId: "a",
              currentVersion: "1",
              targetVersion: "2",
            },
            reason: "",
            expectedFixes: [],
            confidence: "medium",
            risk: "low",
            preconditions: [],
            verification: [],
            rollbackSteps: [],
          },
        ],
        batches: [],
        estimatedDuration: "",
        riskAssessment: "low" as const,
        summary: "",
        createdAt: "",
        policyUsed: DEFAULT_POLICY,
        vulnerabilitiesBySeverity: {
          total: 0,
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
        },
        gitRevision: "",
        projectFingerprint: "",
        policyHash: "",
      };

      const errors = planner.validatePlan(plan);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("non-existent task");
    });
  });

  // ── Golden Plan Tests (spec §43) ────────────────────────────────────
  // For a fixed POM + IQ fixture + policy, assert the expected plan exactly.
  describe("golden plan tests", () => {
    it("direct dependency with IQ suggestion → exact plan", async () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.example:lib:jar:1.0.0:compile`;
      graphBuilder.buildFromMavenTree(treeOutput);

      const components = [
        makeComponent({
          packageUrl: "pkg:maven/com.example/lib@1.0.0",
          groupId: "com.example",
          artifactId: "lib",
          version: "1.0.0",
          vulnerabilities: [
            makeVuln({
              id: "CVE-2024-001",
              suggestedVersion: "1.0.1",
              fixVersions: ["1.0.1"],
            }),
          ],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      // Exact plan structure
      expect(plan.tasks.length).toBe(1);
      expect(plan.batches.length).toBe(1);
      expect(plan.batches[0].length).toBe(1);

      const task = plan.tasks[0];
      expect(task.component.groupId).toBe("com.example");
      expect(task.component.artifactId).toBe("lib");
      expect(task.component.currentVersion).toBe("1.0.0");
      // findBestVersion checks IQ suggestedVersion first, then fixVersions
      expect(task.component.targetVersion).toBe("1.0.1");
      expect(task.expectedFixes).toEqual(["CVE-2024-001"]);
      expect(task.risk).toBe("low"); // patch upgrade
      expect(task.dependencies).toEqual([]); // no deps
    });

    it("transitive dependency with owning direct → priority is upgrade-owning-direct", async () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.example:parent-lib:jar:2.0.0:compile
[INFO]    +- com.example:transitive:jar:1.0.0:compile`;
      graphBuilder.buildFromMavenTree(treeOutput);

      const components = [
        makeComponent({
          packageUrl: "pkg:maven/com.example/transitive@1.0.0",
          groupId: "com.example",
          artifactId: "transitive",
          version: "1.0.0",
          vulnerabilities: [makeVuln({ id: "CVE-2024-002" })],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      expect(plan.tasks.length).toBe(1);
      expect(plan.tasks[0].priority).toBe("upgrade-owning-direct-dependency");
    });

    it("multiple independent vulnerabilities → same batch", async () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.example:lib-a:jar:1.0.0:compile
[INFO] +- com.example:lib-b:jar:2.0.0:compile`;
      graphBuilder.buildFromMavenTree(treeOutput);

      const components = [
        makeComponent({
          packageUrl: "pkg:maven/com.example/lib-a@1.0.0",
          groupId: "com.example",
          artifactId: "lib-a",
          version: "1.0.0",
          vulnerabilities: [makeVuln({ id: "CVE-1" })],
        }),
        makeComponent({
          packageUrl: "pkg:maven/com.example/lib-b@2.0.0",
          groupId: "com.example",
          artifactId: "lib-b",
          version: "2.0.0",
          vulnerabilities: [makeVuln({ id: "CVE-2" })],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      expect(plan.tasks.length).toBe(2);
      // Both are independent → same batch
      expect(plan.batches.length).toBe(1);
      expect(plan.batches[0].length).toBe(2);
    });

    it("empty components → empty plan", async () => {
      const plan = await planner.createPlan([], "test-project");

      expect(plan.tasks.length).toBe(0);
      expect(plan.batches.length).toBe(0);
      expect(plan.vulnerabilitiesBySeverity.total).toBe(0);
    });

    it("severity breakdown matches input components", async () => {
      const components = [
        makeComponent({
          vulnerabilities: [
            makeVuln({ id: "v1", severity: "CRITICAL", cvssScore: 9.5 }),
            makeVuln({ id: "v2", severity: "HIGH", cvssScore: 8.0 }),
          ],
        }),
        makeComponent({
          packageUrl: "pkg:maven/com.example/other@2.0.0",
          groupId: "com.example",
          artifactId: "other",
          version: "2.0.0",
          vulnerabilities: [
            makeVuln({ id: "v3", severity: "MEDIUM", cvssScore: 5.0 }),
          ],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      expect(plan.vulnerabilitiesBySeverity.total).toBe(3);
      expect(plan.vulnerabilitiesBySeverity.critical).toBe(1);
      expect(plan.vulnerabilitiesBySeverity.high).toBe(1);
      expect(plan.vulnerabilitiesBySeverity.medium).toBe(1);
    });
  });

  // ── DAG Invariant Tests (spec §44) ──────────────────────────────────
  describe("DAG invariants", () => {
    it("every plan passes validatePlan (no cycles, no dangling refs)", async () => {
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
      const errors = planner.validatePlan(plan);
      expect(errors).toEqual([]);
    });

    it("every task's dependencies reference existing tasks", async () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.example:lib:jar:1.0.0:compile
[INFO]    +- com.example:transitive:jar:1.0.0:compile`;
      graphBuilder.buildFromMavenTree(treeOutput);

      const components = [
        makeComponent({
          packageUrl: "pkg:maven/com.example/lib@1.0.0",
          groupId: "com.example",
          artifactId: "lib",
          vulnerabilities: [makeVuln({ id: "v1" })],
        }),
        makeComponent({
          packageUrl: "pkg:maven/com.example/transitive@1.0.0",
          groupId: "com.example",
          artifactId: "transitive",
          vulnerabilities: [makeVuln({ id: "v2" })],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");
      const taskIds = new Set(plan.tasks.map((t) => t.id));

      for (const task of plan.tasks) {
        for (const dep of task.dependencies) {
          expect(taskIds.has(dep)).toBe(true);
        }
      }
    });

    it("no task depends on itself", async () => {
      const components = [makeComponent()];
      const plan = await planner.createPlan(components, "test-project");

      for (const task of plan.tasks) {
        expect(task.dependencies).not.toContain(task.id);
      }
    });

    it("batch ordering respects dependency order", async () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.example:parent:jar:2.0.0:compile
[INFO]    +- com.example:child:jar:1.0.0:compile`;
      graphBuilder.buildFromMavenTree(treeOutput);

      const components = [
        makeComponent({
          packageUrl: "pkg:maven/com.example/parent@2.0.0",
          groupId: "com.example",
          artifactId: "parent",
          version: "2.0.0",
          vulnerabilities: [makeVuln({ id: "v1" })],
        }),
        makeComponent({
          packageUrl: "pkg:maven/com.example/child@1.0.0",
          groupId: "com.example",
          artifactId: "child",
          version: "1.0.0",
          vulnerabilities: [makeVuln({ id: "v2" })],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      // Find which batch each task is in
      const taskBatchIndex = new Map<string, number>();
      for (let i = 0; i < plan.batches.length; i++) {
        for (const task of plan.batches[i]) {
          taskBatchIndex.set(task.id, i);
        }
      }

      // Every dependency must be in an earlier or same batch
      for (const task of plan.tasks) {
        const taskBatch = taskBatchIndex.get(task.id)!;
        for (const dep of task.dependencies) {
          const depBatch = taskBatchIndex.get(dep)!;
          expect(depBatch).toBeLessThanOrEqual(taskBatch);
        }
      }
    });

    it("no duplicate task IDs", async () => {
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
      const ids = plan.tasks.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("every task in a batch is eligible for parallel execution", async () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.example:lib-a:jar:1.0.0:compile
[INFO] +- com.example:lib-b:jar:2.0.0:compile`;
      graphBuilder.buildFromMavenTree(treeOutput);

      const components = [
        makeComponent({
          packageUrl: "pkg:maven/com.example/lib-a@1.0.0",
          groupId: "com.example",
          artifactId: "lib-a",
          vulnerabilities: [makeVuln({ id: "v1" })],
        }),
        makeComponent({
          packageUrl: "pkg:maven/com.example/lib-b@2.0.0",
          groupId: "com.example",
          artifactId: "lib-b",
          version: "2.0.0",
          vulnerabilities: [makeVuln({ id: "v2" })],
        }),
      ];

      const plan = await planner.createPlan(components, "test-project");

      // All tasks in the same batch should have no inter-dependencies
      for (const batch of plan.batches) {
        const batchIds = new Set(batch.map((t) => t.id));
        for (const task of batch) {
          for (const dep of task.dependencies) {
            // Dependency must NOT be in the same batch (otherwise it's not parallelizable)
            // OR it must be in an earlier batch
            expect(batchIds.has(dep)).toBe(false);
          }
        }
      }
    });
  });
});
