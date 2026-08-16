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
    const parentAtDepth = new Map<number, string>();
    const scopes = new Set<DependencyScope>(["compile", "runtime", "test", "provided", "system"]);

    for (const rawLine of treeOutput.split("\n")) {
      const content = rawLine.replace(/^\[INFO\]\s?/, "");
      const match = content.match(/^((?:\|  |   )*)(?:\+- |\\- )(.+)$/);
      if (!match || match[2].includes("omitted for")) continue;
      const coordinate = match[2].trim().split(/\s+\(/, 1)[0];
      const parts = coordinate.split(":");
      const scope = parts.at(-1) as DependencyScope;
      if (!scopes.has(scope) || (parts.length !== 5 && parts.length !== 6)) continue;

      const groupId = parts[0];
      const artifactId = parts[1];
      const version = parts.at(-2) ?? "";
      if (!groupId || !artifactId || !version) continue;
      const depth = match[1].length / 3 + 1;
      const packageUrl = `pkg:maven/${groupId}/${artifactId}@${version}`;
      const isDirect = depth === 1;
      const currentParent = parentAtDepth.get(depth - 1) ?? null;
      const existing = this.graph.nodes.get(packageUrl);
      const node: DependencyNode = existing ?? {
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
      node.isDirect ||= isDirect;
      node.depth = Math.min(node.depth, depth);
      if (currentParent && !node.importedBy.includes(currentParent)) node.importedBy.push(currentParent);
      this.graph.nodes.set(packageUrl, node);
      const classification = isDirect ? this.graph.directDependencies : this.graph.transitiveDependencies;
      if (!classification.includes(packageUrl)) classification.push(packageUrl);
      if (isDirect) {
        this.graph.transitiveDependencies = this.graph.transitiveDependencies.filter(
          (candidate) => candidate !== packageUrl,
        );
      }

      if (currentParent) {
        const parent = this.graph.nodes.get(currentParent);
        if (parent && !parent.children.includes(packageUrl)) parent.children.push(packageUrl);
      }
      parentAtDepth.set(depth, packageUrl);
      for (const key of parentAtDepth.keys()) if (key > depth) parentAtDepth.delete(key);
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

    // Only mark coordinates that can be attributed safely. Group-prefix
    // guesses for third-party libraries can cause a component version to be
    // written into the Spring Boot parent version.
    const defaultPrefixes = ["pkg:maven/org.springframework.boot/"];

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
