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

  describe("findOwningDirectDependency", () => {
    it("should find the owning direct dependency for a transitive dep", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.google.guava:guava:jar:31.1-jre:compile
[INFO] |  +- com.google.guava:failureaccess:jar:1.0.1:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      const owner = builder.findOwningDirectDependency(
        "com.google.guava",
        "failureaccess",
      );

      expect(owner).not.toBeNull();
      expect(owner?.artifactId).toBe("guava");
    });

    it("should return the node itself if it is a direct dependency", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.google.guava:guava:jar:31.1-jre:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      const owner = builder.findOwningDirectDependency(
        "com.google.guava",
        "guava",
      );

      expect(owner).not.toBeNull();
      expect(owner?.artifactId).toBe("guava");
      expect(owner?.isDirect).toBe(true);
    });

    it("should return null for unknown dependencies", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.google.guava:guava:jar:31.1-jre:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      const owner = builder.findOwningDirectDependency(
        "com.unknown",
        "nonexistent",
      );

      expect(owner).toBeNull();
    });
  });

  describe("getVulnerableComponentsWithOwners", () => {
    it("should return vulnerable components with their owners", () => {
      const treeOutput = `[INFO] com.example:my-app:jar:1.0.0
[INFO] +- com.google.guava:guava:jar:31.1-jre:compile
[INFO] |  +- com.google.guava:failureaccess:jar:1.0.1:compile`;

      const builder = new DependencyGraphBuilder();
      builder.buildFromMavenTree(treeOutput);

      // Mark a vulnerability
      const failureaccessNode = builder
        .getGraph()
        .nodes.get("pkg:maven/com.google.guava/failureaccess@1.0.1");
      if (failureaccessNode) {
        failureaccessNode.vulnerabilities = [
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
            fixVersions: ["1.0.2"],
            firstPublished: "2024-01-01",
            lastModified: "2024-01-01",
          },
        ];
        builder
          .getGraph()
          .vulnerableComponents.push(
            "pkg:maven/com.google.guava/failureaccess@1.0.1",
          );
      }

      const result = builder.getVulnerableComponentsWithOwners();

      expect(result.length).toBe(1);
      expect(result[0].component.artifactId).toBe("failureaccess");
      expect(result[0].owner?.artifactId).toBe("guava");
    });
  });
});
