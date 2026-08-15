import { createChildLogger } from "../utils/logger.js";
import {
  isUpgradeAllowed,
  isSnapshot,
  isPreRelease,
  isRedHatBuild,
  parseVersion,
} from "../utils/semver.js";
import type {
  PolicyConfig,
  Severity,
  RemediationPriority,
  RemediationTask,
  Component,
  DependencyNode,
  Vulnerability,
} from "../types/index.js";
import { randomUUID } from "node:crypto";

const log = createChildLogger("PolicyEngine");

export class PolicyEngine {
  private policy: PolicyConfig;

  constructor(policy: PolicyConfig) {
    this.policy = policy;
    log.info("Policy engine initialized", JSON.stringify(policy, null, 2));
  }

  // Get current policy
  getPolicy(): PolicyConfig {
    return { ...this.policy };
  }

  // Update policy
  updatePolicy(updates: Partial<PolicyConfig>): void {
    this.policy = { ...this.policy, ...updates };
    log.info("Policy updated", JSON.stringify(updates, null, 2));
  }

  // Check if vulnerability should be addressed based on severity
  shouldAddressVulnerability(vulnerability: Vulnerability): boolean {
    return this.policy.severity.includes(vulnerability.severity);
  }

  // Filter components by policy
  filterComponentsByPolicy(components: Component[]): Component[] {
    return components
      .map((comp) => ({
        ...comp,
        vulnerabilities: comp.vulnerabilities.filter((v) =>
          this.shouldAddressVulnerability(v),
        ),
      }))
      .filter((comp) => comp.vulnerabilities.length > 0);
  }

  // Evaluate upgrade suggestion from IQ
  evaluateIQSuggestion(
    suggestedVersion: string,
    currentVersion: string,
  ): { accepted: boolean; reason: string } {
    // Check if snapshots are allowed
    if (!this.policy.allowSnapshots && isSnapshot(suggestedVersion)) {
      return { accepted: false, reason: "Snapshots not allowed by policy" };
    }

    // Check if pre-release is allowed
    if (isPreRelease(suggestedVersion)) {
      return { accepted: false, reason: "Pre-release versions not allowed" };
    }

    // Check if Red Hat build is allowed
    if (!this.policy.allowRedhat && isRedHatBuild(suggestedVersion)) {
      return { accepted: false, reason: "Red Hat builds not allowed" };
    }

    // Check upgrade type
    const upgradeCheck = isUpgradeAllowed(currentVersion, suggestedVersion, {
      allowPatch: this.policy.allowPatch,
      allowMinor: this.policy.allowMinor,
      allowMajor: this.policy.allowMajor,
      allowSnapshots: this.policy.allowSnapshots,
      allowRedhat: this.policy.allowRedhat,
    });

    if (!upgradeCheck.allowed) {
      return {
        accepted: false,
        reason: upgradeCheck.reason || "Upgrade not allowed",
      };
    }

    return { accepted: true, reason: "Upgrade accepted by policy" };
  }

  // Determine remediation priority
  determinePriority(
    component: Component,
    _dependencyNode?: DependencyNode,
    _springBootManaged?: boolean,
    directDependency?: boolean,
    unused?: boolean,
  ): RemediationPriority {
    // If unused, highest priority is to remove
    if (unused && this.policy.removeUnused) {
      return "remove-unused";
    }

    // NOTE: Spring Boot-managed components are intentionally NOT given an
    // individual task here. Per the Spring Boot Rule, they are handled by the
    // single dedicated parent-upgrade task in the Planner. Returning
    // 'upgrade-spring-boot-parent' here would set the parent version to the
    // component's own version and corrupt the POM.

    // If IQ suggestion exists and we prefer it, use it (more precise than generic upgrade)
    if (
      this.policy.preferIqSuggestion &&
      component.vulnerabilities.some((v) => v.suggestedVersion)
    ) {
      return "apply-iq-suggestion";
    }

    // If direct dependency, prefer upgrading it
    if (directDependency && this.policy.preferOwningDependency) {
      return "upgrade-owning-direct-dependency";
    }

    // Default to search Nexus
    return "search-nexus-latest";
  }

  // Create remediation task
  createTask(
    component: Component,
    priority: RemediationPriority,
    targetVersion: string,
    dependencies: string[] = [],
  ): RemediationTask {
    const vulnerabilityIds = component.vulnerabilities.map((v) => v.id);
    const highestSeverity = this.getHighestSeverity(component.vulnerabilities);

    // Determine risk based on upgrade type and severity
    const risk = this.calculateRisk(
      component.version,
      targetVersion,
      highestSeverity,
    );

    // Determine confidence based on priority and suggestion availability
    const confidence = this.calculateConfidence(priority, component);

    return {
      id: randomUUID(),
      priority,
      description: this.generateDescription(priority, component, targetVersion),
      component: {
        groupId: component.groupId,
        artifactId: component.artifactId,
        currentVersion: component.version,
        targetVersion,
      },
      reason: this.generateReason(priority, component, targetVersion),
      expectedFixes: vulnerabilityIds,
      confidence,
      risk,
      preconditions: this.getPreconditions(priority),
      verification: this.getVerificationSteps(priority),
      rollbackSteps: this.getRollbackSteps(priority),
      dependencies,
      status: "pending",
    };
  }

  // Get highest severity from vulnerabilities
  private getHighestSeverity(vulnerabilities: Vulnerability[]): Severity {
    const severityOrder: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
    for (const severity of severityOrder) {
      if (vulnerabilities.some((v) => v.severity === severity)) {
        return severity;
      }
    }
    return "LOW";
  }

  // Calculate risk level
  private calculateRisk(
    currentVersion: string,
    targetVersion: string,
    highestSeverity: Severity,
  ): "low" | "medium" | "high" {
    // Major upgrades are higher risk
    const current = parseVersion(currentVersion);
    const target = parseVersion(targetVersion);

    if (current && target) {
      if (target.major > current.major) return "high";
      if (target.minor > current.minor) return "medium";
    }

    // Critical vulnerabilities increase risk
    if (highestSeverity === "CRITICAL") return "medium";

    return "low";
  }

  // Calculate confidence level
  private calculateConfidence(
    priority: RemediationPriority,
    component: Component,
  ): "high" | "medium" | "low" {
    // IQ suggested version has highest confidence
    if (
      priority === "apply-iq-suggestion" &&
      component.vulnerabilities.some((v) => v.suggestedVersion)
    ) {
      return "high";
    }

    // Parent upgrade has high confidence
    if (priority === "upgrade-spring-boot-parent") {
      return "high";
    }

    // Direct dependency upgrade has medium confidence
    if (
      priority === "upgrade-owning-direct-dependency" ||
      priority === "upgrade-direct-dependency"
    ) {
      return "medium";
    }

    // Search Nexus has lower confidence
    return "low";
  }

  // Generate task description
  private generateDescription(
    priority: RemediationPriority,
    component: Component,
    targetVersion: string,
  ): string {
    const { groupId, artifactId, version } = component;
    const componentRef = `${groupId}:${artifactId}`;

    switch (priority) {
      case "upgrade-spring-boot-parent":
        return `Upgrade Spring Boot parent to fix ${componentRef}`;
      case "upgrade-owning-direct-dependency":
        return `Upgrade ${componentRef} ${version} → ${targetVersion}`;
      case "upgrade-direct-dependency":
        return `Upgrade ${componentRef} ${version} → ${targetVersion}`;
      case "apply-iq-suggestion":
        return `Apply IQ suggested version for ${componentRef}`;
      case "search-nexus-latest":
        return `Find and apply latest stable version for ${componentRef}`;
      case "override-transitive":
        return `Override transitive dependency ${componentRef}`;
      case "exclude-and-replace":
        return `Exclude and replace ${componentRef}`;
      case "remove-unused":
        return `Remove unused dependency ${componentRef}`;
      default:
        return `Remediate ${componentRef}`;
    }
  }

  // Generate reason for the task (spec §34 — includes source of recommendation)
  private generateReason(
    priority: RemediationPriority,
    component: Component,
    targetVersion: string,
  ): string {
    const vulnCount = component.vulnerabilities.length;
    const severities = [
      ...new Set(component.vulnerabilities.map((v) => v.severity)),
    ].join(", ");

    const sourceMap: Record<RemediationPriority, string> = {
      "upgrade-spring-boot-parent": "Spring Boot coordinated upgrade",
      "upgrade-owning-direct-dependency": "dependency ownership analysis",
      "upgrade-direct-dependency": "direct dependency upgrade",
      "apply-iq-suggestion": "IQ Server recommendation",
      "search-nexus-latest": "Nexus version search",
      "override-transitive": "transitive dependency override",
      "exclude-and-replace": "exclusion and replacement",
      "remove-unused": "unused dependency analysis",
    };

    const source = sourceMap[priority] ?? "policy rule";
    return `Fixes ${vulnCount} vulnerabilities (${severities}) via ${source}. Target: ${component.groupId}:${component.artifactId} → ${targetVersion}`;
  }

  // Get preconditions for a task
  private getPreconditions(priority: RemediationPriority): string[] {
    const base = ["Project builds successfully"];

    switch (priority) {
      case "upgrade-spring-boot-parent":
        return [...base, "Verify Spring Boot compatibility"];
      case "upgrade-owning-direct-dependency":
      case "upgrade-direct-dependency":
        return [...base, "Verify API compatibility"];
      case "remove-unused":
        return [...base, "Verify dependency is truly unused"];
      default:
        return base;
    }
  }

  // Get verification steps
  private getVerificationSteps(_priority: RemediationPriority): string[] {
    const base = ["Run mvn clean verify"];

    if (this.policy.verifyIq) {
      base.push("Run IQ scan to verify vulnerabilities resolved");
    }

    return base;
  }

  // Get rollback steps
  private getRollbackSteps(_priority: RemediationPriority): string[] {
    return [
      "Restore pom.xml from backup",
      "Verify build succeeds after rollback",
    ];
  }

  // Check if we should try Spring Boot upgrade first
  shouldTrySpringBootUpgradeFirst(
    springBootManagedCount: number,
    totalVulnerabilities: number,
  ): boolean {
    if (!this.policy.preferParentUpgrade) return false;

    // If more than 50% of vulnerabilities are Spring Boot managed
    const ratio = springBootManagedCount / totalVulnerabilities;
    return ratio > 0.5;
  }

  // Validate policy configuration
  validatePolicy(policy: Partial<PolicyConfig>): string[] {
    const errors: string[] = [];

    if (policy.severity) {
      const validSeverities: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
      const invalid = policy.severity.filter(
        (s) => !validSeverities.includes(s),
      );
      if (invalid.length > 0) {
        errors.push(`Invalid severity levels: ${invalid.join(", ")}`);
      }
    }

    if (policy.maxBatchSize !== undefined && policy.maxBatchSize < 1) {
      errors.push("maxBatchSize must be at least 1");
    }

    if (policy.timeout !== undefined && policy.timeout < 1000) {
      errors.push("timeout must be at least 1000ms");
    }

    return errors;
  }
}
