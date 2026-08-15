import { createChildLogger } from "../utils/logger.js";
import type {
  DependencyNode,
  DependencyGraph,
  DependencyScope,
  IQReport,
  ProjectInfo,
} from "../types/index.js";

const log = createChildLogger("DependencyGraph");

export class DependencyGraphBuilder {
  private graph: DependencyGraph;

  constructor() {
    this.graph = {
      nodes: new Map(),
      directDependencies: [],
      transitiveDependencies: [],
      springBootManaged: [],
      vulnerableComponents: [],
    };
  }

  // Reset the graph
  reset(): void {
    this.graph = {
      nodes: new Map(),
      directDependencies: [],
      transitiveDependencies: [],
      springBootManaged: [],
      vulnerableComponents: [],
    };
  }

  // Get current graph
  getGraph(): DependencyGraph {
    return this.graph;
  }

  /**
   * Find a node by groupId and artifactId, ignoring version.
   * Returns the first match, or undefined if not found.
   * This is needed because IQ reports and POM dependencyManagement may use
   * different version strings than the resolved dependency tree.
   */
  findNodeByArtifact(
    groupId: string,
    artifactId: string,
  ): DependencyNode | undefined {
    for (const node of this.graph.nodes.values()) {
      if (node.groupId === groupId && node.artifactId === artifactId) {
        return node;
      }
    }
    return undefined;
  }

  // Build graph from Maven dependency tree output
  buildFromMavenTree(treeOutput: string): void {
    this.reset();

    const lines = treeOutput.split("\n");
    // Stack of parents keyed by depth level — tracks the correct parent at each depth
    const parentAtDepth = new Map<number, string>();

    for (const line of lines) {
      // Match dependency lines like: [INFO]    +- com.example:lib:jar:1.0.0:compile
      // The prefix before the artifact contains tree chars and spaces.
      // Depth calculation: prefix length follows pattern 2, 5, 8, 11...
      // depth = (prefixLength + 1) / 3
      const match = line.match(
        /\[INFO\]\s+([ |+\-]+?)\s+([\w.\-]+):([\w.\-]+):([\w.\-]+):([\w.\-]+)(?::([\w.\-]+))?\s*:(compile|runtime|test|provided|system)/,
      );

      if (match) {
        const prefix = match[1];
        const depth = Math.floor((prefix.length + 1) / 3);
        const groupId = match[2];
        const artifactId = match[3];
        // match[4] is the artifact type (jar, war, etc.)
        const version = match[5];
        const scope = match[7] as DependencyScope;

        const packageUrl = `pkg:maven/${groupId}/${artifactId}@${version}`;
        const isDirect = depth === 1;

        // Determine parent: the node at depth-1, or null for root
        const currentParent = parentAtDepth.get(depth - 1) ?? null;

        const node: DependencyNode = {
          packageUrl,
          groupId,
          artifactId,
          version,
          scope,
          isDirect,
          isManagedBySpringBoot: false,
          isDeclaredInDependencyManagement: false,
          importedBy: currentParent ? [currentParent] : [],
          children: [],
          vulnerabilities: [],
          isUsed: true,
          depth,
        };

        this.graph.nodes.set(packageUrl, node);

        if (isDirect) {
          this.graph.directDependencies.push(packageUrl);
        } else {
          this.graph.transitiveDependencies.push(packageUrl);
        }

        // Add as child of parent
        if (currentParent) {
          const parentNode = this.graph.nodes.get(currentParent);
          if (parentNode) {
            parentNode.children.push(packageUrl);
          }
        }

        // Store this node as the parent for its depth level
        parentAtDepth.set(depth, packageUrl);

        // Clear deeper levels — any children from a previous branch at depth > current
        // are no longer relevant as parents
        for (const key of parentAtDepth.keys()) {
          if (key > depth) parentAtDepth.delete(key);
        }
      }
    }

    log.info(`Built graph with ${this.graph.nodes.size} nodes`);
  }

  // Mark Spring Boot managed dependencies
  // Accepts optional additional prefixes from POM dependencyManagement
  markSpringBootManaged(
    projectInfo: ProjectInfo,
    additionalPrefixes: string[] = [],
  ): void {
    if (!projectInfo.springBootVersion) return;

    // Common Spring Boot managed dependencies
    const defaultPrefixes = [
      "pkg:maven/org.springframework.boot/",
      "pkg:maven/com.fasterxml.jackson/",
      "pkg:maven/org.apache.tomcat/",
      "pkg:maven/org.yaml/",
      "pkg:maven/ch.qos.logback/",
      "pkg:maven/org.slf4j/",
      "pkg:maven/io.micrometer/",
    ];

    // Merge with additional prefixes (from POM dependencyManagement)
    const allPrefixes = [
      ...new Set([...defaultPrefixes, ...additionalPrefixes]),
    ];

    for (const [packageUrl, node] of this.graph.nodes) {
      // Check if parent is Spring Boot
      if (
        node.importedBy.some((imported) => imported.includes("spring-boot"))
      ) {
        node.isManagedBySpringBoot = true;
        this.graph.springBootManaged.push(packageUrl);
      }

      // Check by package URL prefix
      if (allPrefixes.some((prefix) => packageUrl.startsWith(prefix))) {
        node.isManagedBySpringBoot = true;
        if (!this.graph.springBootManaged.includes(packageUrl)) {
          this.graph.springBootManaged.push(packageUrl);
        }
      }
    }

    log.info(
      `Marked ${this.graph.springBootManaged.length} Spring Boot managed dependencies`,
    );
  }

  // Mark dependencies from dependencyManagement
  markDependencyManagement(
    dependencyManagement: Array<{
      groupId: string;
      artifactId: string;
      version: string;
    }>,
  ): void {
    for (const managed of dependencyManagement) {
      // Use version-agnostic lookup — POM dependencyManagement versions may
      // differ from the resolved version in the dependency tree
      const node = this.findNodeByArtifact(managed.groupId, managed.artifactId);
      if (node) {
        node.isDeclaredInDependencyManagement = true;
      }
    }
  }

  // Mark vulnerable components from IQ report
  markVulnerableComponents(iqReport: IQReport): void {
    for (const component of iqReport.components) {
      // Try exact packageUrl match first, then fall back to groupId:artifactId
      let node = this.graph.nodes.get(component.packageUrl);
      if (!node) {
        node = this.findNodeByArtifact(component.groupId, component.artifactId);
      }

      if (node) {
        node.vulnerabilities = component.vulnerabilities;
        const packageUrl = node.packageUrl;
        if (!this.graph.vulnerableComponents.includes(packageUrl)) {
          this.graph.vulnerableComponents.push(packageUrl);
        }
      } else {
        // Component not in dependency tree, might be indirect
        log.debug(`Vulnerable component not in tree: ${component.packageUrl}`);
      }
    }

    log.info(
      `Marked ${this.graph.vulnerableComponents.length} vulnerable components`,
    );
  }

  // Get statistics
  getStats(): {
    totalDependencies: number;
    directDependencies: number;
    transitiveDependencies: number;
    springBootManaged: number;
    vulnerableComponents: number;
    totalVulnerabilities: number;
  } {
    let totalVulnerabilities = 0;
    for (const packageUrl of this.graph.vulnerableComponents) {
      const node = this.graph.nodes.get(packageUrl);
      if (node) {
        totalVulnerabilities += node.vulnerabilities.length;
      }
    }

    return {
      totalDependencies: this.graph.nodes.size,
      directDependencies: this.graph.directDependencies.length,
      transitiveDependencies: this.graph.transitiveDependencies.length,
      springBootManaged: this.graph.springBootManaged.length,
      vulnerableComponents: this.graph.vulnerableComponents.length,
      totalVulnerabilities,
    };
  }
}
