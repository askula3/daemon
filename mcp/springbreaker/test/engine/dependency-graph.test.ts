import { describe, it, expect } from "vitest";
import { DependencyGraphBuilder } from "../../src/engine/dependency-graph.js";

describe("DependencyGraphBuilder", () => {
  describe("buildFromMavenTree", () => {
    it("should parse Maven dependency tree output", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.google.guava:guava:jar:31.1-jre:compile
[INFO] |  +- com.google.guava:failureaccess:jar:1.0.1:compile
[INFO] |  +- com.google.guava:listenablefuture:jar:9999.0-empty-to-avoid-conflict-with-guava:compile
[INFO] |  +- com.google.code.findbugs:jsr305:jar:3.0.2:compile
[INFO] |  +- org.checkerframework:checker-qual:jar:3.12.0:compile
[INFO] |  +- com.google.errorprone:error_prone_annotations:jar:2.11.0:compile
[INFO] |  +- com.google.j2objc:j2objc-annotations:jar:1.3:compile
[INFO] +- org.apache.commons:commons-lang3:jar:3.12.0:compile
[INFO] +- junit:junit:jar:4.13.2:test
[INFO]    +- org.hamcrest:hamcrest-core:jar:1.3:test`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      const graph = builder.getGraph();

      expect(graph.nodes.size).toBeGreaterThan(0);
      expect(graph.directDependencies.length).toBeGreaterThan(0);
      expect(graph.transitiveDependencies.length).toBeGreaterThan(0);
    });

    it("should correctly track parent-child relationships for siblings", () => {
      // This tests the parent tracking fix — siblings should have the same parent
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.google.guava:guava:jar:31.1-jre:compile
[INFO] |  +- com.google.guava:failureaccess:jar:1.0.1:compile
[INFO] +- org.apache.commons:commons-lang3:jar:3.12.0:compile
[INFO] |  +- org.apache.commons:commons-text:jar:1.10.0:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      const graph = builder.getGraph();

      // Both guava and commons-lang3 should be direct dependencies
      expect(graph.directDependencies.length).toBe(2);

      // failureaccess should be imported by guava
      const failureaccessNode = graph.nodes.get(
        "pkg:maven/com.google.guava/failureaccess@1.0.1",
      );
      expect(failureaccessNode).toBeDefined();
      expect(failureaccessNode?.importedBy.length).toBe(1);
      expect(failureaccessNode?.importedBy[0]).toContain("guava");

      // commons-text should be imported by commons-lang3
      const commonsTextNode = graph.nodes.get(
        "pkg:maven/org.apache.commons/commons-text@1.10.0",
      );
      expect(commonsTextNode).toBeDefined();
      expect(commonsTextNode?.importedBy.length).toBe(1);
      expect(commonsTextNode?.importedBy[0]).toContain("commons-lang3");

      // guava should NOT be the parent of commons-text
      expect(commonsTextNode?.importedBy[0]).not.toContain("guava");
    });
  });

  describe("getStats", () => {
    it("should return correct statistics", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.google.guava:guava:jar:31.1-jre:compile
[INFO] |  +- com.google.guava:failureaccess:jar:1.0.1:compile
[INFO] +- org.apache.commons:commons-lang3:jar:3.12.0:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      const stats = builder.getStats();

      expect(stats.totalDependencies).toBeGreaterThan(0);
      expect(stats.directDependencies).toBeGreaterThan(0);
      expect(stats.transitiveDependencies).toBeGreaterThanOrEqual(0);
    });
  });

  describe("markSpringBootManaged", () => {
    it("marks dependencies from Spring Boot parent as managed", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- org.springframework.boot:spring-boot-starter-web:jar:3.2.0:compile
[INFO] |  +- org.springframework.boot:spring-boot-starter:jar:3.2.0:compile
[INFO] |  |  +- org.springframework.boot:spring-boot:jar:3.2.0:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      builder.markSpringBootManaged({
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

      const graph = builder.getGraph();
      expect(graph.springBootManaged.length).toBeGreaterThan(0);
    });
  });

  describe("markDependencyManagement", () => {
    it("marks dependencies declared in dependencyManagement", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.google.guava:guava:jar:31.1-jre:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      builder.markDependencyManagement([
        {
          groupId: "com.google.guava",
          artifactId: "guava",
          version: "31.1-jre",
        },
      ]);

      const guavaNode = builder.findNodeByArtifact("com.google.guava", "guava");
      expect(guavaNode?.isDeclaredInDependencyManagement).toBe(true);
    });
  });

  describe("markVulnerableComponents", () => {
    it("marks components with vulnerabilities from IQ report", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.google.guava:guava:jar:31.1-jre:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      const report = {
        reportId: "r1",
        applicationId: "test",
        scanId: "s1",
        scanTime: new Date().toISOString(),
        components: [
          {
            packageUrl: "pkg:maven/com.google.guava/guava@31.1-jre",
            displayName: "guava",
            version: "31.1-jre",
            groupId: "com.google.guava",
            artifactId: "guava",
            extension: "jar",
            vulnerabilities: [
              {
                id: "CVE-2023-1234",
                referenceUrl: "http://example.com",
                description: "Test",
                severity: "HIGH" as const,
                cvssScore: 8.0,
                CWEs: [],
                licenseRisk: false,
                componentDisplayName: "guava",
                pathNames: [],
                fixVersions: ["32.0.0"],
                firstPublished: "2024-01-01",
                lastModified: "2024-01-01",
              },
            ],
          },
        ],
        totalVulnerabilities: 1,
        vulnerabilitiesBySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
      };

      builder.markVulnerableComponents(report);

      const guavaNode = builder.findNodeByArtifact("com.google.guava", "guava");
      expect(guavaNode?.vulnerabilities.length).toBe(1);
      expect(builder.getGraph().vulnerableComponents.length).toBe(1);
    });
  });

  describe("findNodeByArtifact", () => {
    it("finds a node by groupId and artifactId (version-agnostic)", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.google.guava:guava:jar:31.1-jre:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      const node = builder.findNodeByArtifact("com.google.guava", "guava");
      expect(node).toBeDefined();
      expect(node?.artifactId).toBe("guava");
      expect(node?.version).toBe("31.1-jre");
    });

    it("returns undefined for nonexistent artifact", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.google.guava:guava:jar:31.1-jre:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      const node = builder.findNodeByArtifact("nonexistent", "dep");
      expect(node).toBeUndefined();
    });
  });

  describe("reset", () => {
    it("clears the graph", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.google.guava:guava:jar:31.1-jre:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);
      expect(builder.getGraph().nodes.size).toBeGreaterThan(0);

      builder.reset();
      expect(builder.getGraph().nodes.size).toBe(0);
    });
  });

  describe("deep nesting", () => {
    it("handles deeply nested dependencies (3+ levels)", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.example:level1:jar:1.0.0:compile
[INFO] |  +- com.example:level2:jar:1.0.0:compile
[INFO] |  |  +- com.example:level3:jar:1.0.0:compile
[INFO] |  |  |  +- com.example:level4:jar:1.0.0:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      const graph = builder.getGraph();
      expect(graph.nodes.size).toBe(4);

      const level4 = builder.findNodeByArtifact("com.example", "level4");
      expect(level4).toBeDefined();
      expect(level4?.depth).toBe(4);
    });
  });
});
