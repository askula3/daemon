import { describe, it, expect, beforeEach } from "vitest";
import { PolicyEngine } from "../../src/engine/policy-engine.js";
import { DEFAULT_POLICY } from "../../src/config.js";
import type { Component, Vulnerability } from "../../src/types/index.js";

describe("PolicyEngine", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine(DEFAULT_POLICY);
  });

  describe("shouldAddressVulnerability", () => {
    it("should address HIGH severity vulnerabilities", () => {
      const vuln: Vulnerability = {
        id: "vuln-1",
        referenceUrl: "http://example.com",
        description: "Test vulnerability",
        severity: "HIGH",
        cvssScore: 8.0,
        CWEs: ["CWE-123"],
        licenseRisk: false,
        componentDisplayName: "test:lib:1.0.0",
        pathNames: [],
        fixVersions: ["1.0.1"],
        firstPublished: "2024-01-01",
        lastModified: "2024-01-01",
      };

      expect(engine.shouldAddressVulnerability(vuln)).toBe(true);
    });

    it("should not address LOW severity vulnerabilities by default", () => {
      const vuln: Vulnerability = {
        id: "vuln-1",
        referenceUrl: "http://example.com",
        description: "Test vulnerability",
        severity: "LOW",
        cvssScore: 3.0,
        CWEs: ["CWE-123"],
        licenseRisk: false,
        componentDisplayName: "test:lib:1.0.0",
        pathNames: [],
        fixVersions: ["1.0.1"],
        firstPublished: "2024-01-01",
        lastModified: "2024-01-01",
      };

      expect(engine.shouldAddressVulnerability(vuln)).toBe(false);
    });
  });

  describe("filterComponentsByPolicy", () => {
    it("should filter components by severity", () => {
      const components: Component[] = [
        {
          packageUrl: "pkg:maven/com.example/lib@1.0.0",
          displayName: "com.example:lib:1.0.0",
          version: "1.0.0",
          groupId: "com.example",
          artifactId: "lib",
          extension: "jar",
          vulnerabilities: [
            {
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
            },
          ],
        },
        {
          packageUrl: "pkg:maven/com.example/other@1.0.0",
          displayName: "com.example:other:1.0.0",
          version: "1.0.0",
          groupId: "com.example",
          artifactId: "other",
          extension: "jar",
          vulnerabilities: [
            {
              id: "vuln-2",
              referenceUrl: "http://example.com",
              description: "Test vulnerability",
              severity: "LOW",
              cvssScore: 3.0,
              CWEs: [],
              licenseRisk: false,
              componentDisplayName: "test:other:1.0.0",
              pathNames: [],
              fixVersions: ["1.0.1"],
              firstPublished: "2024-01-01",
              lastModified: "2024-01-01",
            },
          ],
        },
      ];

      const filtered = engine.filterComponentsByPolicy(components);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].artifactId).toBe("lib");
    });
  });

  describe("evaluateIQSuggestion", () => {
    it("should accept valid suggestion", () => {
      const result = engine.evaluateIQSuggestion("1.0.1", "1.0.0");
      expect(result.accepted).toBe(true);
    });

    it("should reject snapshot suggestion", () => {
      const result = engine.evaluateIQSuggestion("1.0.1-SNAPSHOT", "1.0.0");
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("Snapshots");
    });

    it("should reject major upgrade", () => {
      const result = engine.evaluateIQSuggestion("2.0.0", "1.0.0");
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("Major upgrade");
    });
  });

  describe("determinePriority", () => {
    it("should return remove-unused for unused dependencies", () => {
      const component: Component = {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [],
      };

      const priority = engine.determinePriority(
        component,
        undefined,
        false,
        false,
        true,
      );
      expect(priority).toBe("remove-unused");
    });

    it("should NOT return upgrade-spring-boot-parent for Spring Boot managed", () => {
      // Per the Spring Boot Rule, managed components are handled by the single
      // dedicated parent-upgrade task in the Planner — they must NOT get an
      // individual task (which would corrupt the parent version).
      const component: Component = {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [],
      };

      const priority = engine.determinePriority(
        component,
        undefined,
        true,
        false,
        false,
      );
      expect(priority).not.toBe("upgrade-spring-boot-parent");
    });

    it("should return upgrade-owning-direct-dependency for direct dependencies", () => {
      const component: Component = {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [],
      };

      const priority = engine.determinePriority(
        component,
        undefined,
        false,
        true,
        false,
      );
      expect(priority).toBe("upgrade-owning-direct-dependency");
    });
  });

  describe("createTask", () => {
    it("should create a task with correct properties", () => {
      const component: Component = {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [
          {
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
          },
        ],
      };

      const task = engine.createTask(
        component,
        "upgrade-owning-direct-dependency",
        "1.0.1",
      );

      expect(task.component.groupId).toBe("com.example");
      expect(task.component.artifactId).toBe("lib");
      expect(task.component.currentVersion).toBe("1.0.0");
      expect(task.component.targetVersion).toBe("1.0.1");
      expect(task.expectedFixes).toContain("vuln-1");
      expect(task.status).toBe("pending");
    });

    it("should set high confidence for IQ suggestions", () => {
      const component: Component = {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [
          {
            id: "vuln-1",
            referenceUrl: "http://example.com",
            description: "Test vulnerability",
            severity: "HIGH",
            cvssScore: 8.0,
            CWEs: [],
            licenseRisk: false,
            componentDisplayName: "test:lib:1.0.0",
            pathNames: [],
            suggestedVersion: "1.0.1",
            fixVersions: ["1.0.1"],
            firstPublished: "2024-01-01",
            lastModified: "2024-01-01",
          },
        ],
      };

      const task = engine.createTask(component, "apply-iq-suggestion", "1.0.1");

      expect(task.confidence).toBe("high");
    });

    it("should set high confidence for Spring Boot parent upgrade", () => {
      const component: Component = {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [],
      };

      const task = engine.createTask(
        component,
        "upgrade-spring-boot-parent",
        "3.4.9",
      );

      expect(task.confidence).toBe("high");
    });

    it("should set medium confidence for direct dependency upgrade", () => {
      const component: Component = {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [],
      };

      const task = engine.createTask(
        component,
        "upgrade-owning-direct-dependency",
        "1.0.1",
      );

      expect(task.confidence).toBe("medium");
    });

    it("should set low confidence for Nexus search", () => {
      const component: Component = {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [],
      };

      const task = engine.createTask(component, "search-nexus-latest", "1.0.1");

      expect(task.confidence).toBe("low");
    });

    it("should set high risk for major upgrades", () => {
      const component: Component = {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [
          {
            id: "vuln-1",
            referenceUrl: "http://example.com",
            description: "Test vulnerability",
            severity: "HIGH",
            cvssScore: 8.0,
            CWEs: [],
            licenseRisk: false,
            componentDisplayName: "test:lib:1.0.0",
            pathNames: [],
            fixVersions: ["2.0.0"],
            firstPublished: "2024-01-01",
            lastModified: "2024-01-01",
          },
        ],
      };

      const task = engine.createTask(
        component,
        "upgrade-owning-direct-dependency",
        "2.0.0",
      );

      expect(task.risk).toBe("high");
    });

    it("should set medium risk for minor upgrades", () => {
      const component: Component = {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [
          {
            id: "vuln-1",
            referenceUrl: "http://example.com",
            description: "Test vulnerability",
            severity: "HIGH",
            cvssScore: 8.0,
            CWEs: [],
            licenseRisk: false,
            componentDisplayName: "test:lib:1.0.0",
            pathNames: [],
            fixVersions: ["1.1.0"],
            firstPublished: "2024-01-01",
            lastModified: "2024-01-01",
          },
        ],
      };

      const task = engine.createTask(
        component,
        "upgrade-owning-direct-dependency",
        "1.1.0",
      );

      expect(task.risk).toBe("medium");
    });

    it("should include preconditions and verification steps", () => {
      const component: Component = {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [],
      };

      const task = engine.createTask(
        component,
        "upgrade-owning-direct-dependency",
        "1.0.1",
      );

      expect(task.preconditions.length).toBeGreaterThan(0);
      expect(task.verification.length).toBeGreaterThan(0);
      expect(task.rollbackSteps.length).toBeGreaterThan(0);
    });
  });
});
