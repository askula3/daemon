import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../utils/logger.js';
import { compareVersions } from '../utils/semver.js';
import type {
  ExecutionPlan,
  RemediationTask,
  Component,
  DependencyGraph,
  SummaryCount,
  ProjectInfo,
} from '../types/index.js';
import { PolicyEngine } from './policy-engine.js';
import { DependencyGraphBuilder } from './dependency-graph.js';
import { NexusWorker } from '../workers/nexus-worker.js';

const log = createChildLogger('Planner');

export class Planner {
  private policyEngine: PolicyEngine;
  private graphBuilder: DependencyGraphBuilder;
  private nexusWorker: NexusWorker | null;

  constructor(
    policyEngine: PolicyEngine,
    graphBuilder: DependencyGraphBuilder,
    nexusWorker?: NexusWorker | null,
  ) {
    this.policyEngine = policyEngine;
    this.graphBuilder = graphBuilder;
    this.nexusWorker = nexusWorker ?? null;
  }

  // Create execution plan
  async createPlan(
    components: Component[],
    projectId: string,
    projectInfo?: ProjectInfo,
  ): Promise<ExecutionPlan> {
    log.info(`Creating plan for ${components.length} components`);

    const tasks: RemediationTask[] = [];
    const graph = this.graphBuilder.getGraph();

    // Check if we should try Spring Boot upgrade first
    const springBootManagedCount = this.countSpringBootManaged(components);
    if (
      this.policyEngine.shouldTrySpringBootUpgradeFirst(springBootManagedCount, components.length) &&
      projectInfo?.springBootVersion
    ) {
      const bootTask = this.createSpringBootUpgradeTask(
        projectInfo.springBootVersion,
        components,
      );
      if (bootTask) {
        tasks.push(bootTask);
        log.info(`Spring Boot upgrade task created: ${bootTask.description}`);
      }
    }

    // Process each vulnerable component (in parallel for Nexus lookups)
    const componentTasks = await Promise.all(
      components.map(component => this.createTasksForComponent(component, graph))
    );
    for (const ct of componentTasks) {
      tasks.push(...ct);
    }

    // Resolve dependency markers into actual task IDs
    this.resolveDependencyMarkers(tasks, graph);

    // Build batches (DAG-based execution)
    const batches = this.buildBatches(tasks);

    // Calculate risk assessment
    const riskAssessment = this.calculateRiskAssessment(tasks);

    // Estimate duration
    const estimatedDuration = this.estimateDuration(batches);

    // Compute severity breakdown from components
    const vulnerabilitiesBySeverity: SummaryCount = {
      total: 0, critical: 0, high: 0, medium: 0, low: 0,
    };
    for (const component of components) {
      for (const vuln of component.vulnerabilities) {
        vulnerabilitiesBySeverity.total++;
        switch (vuln.severity) {
          case 'CRITICAL': vulnerabilitiesBySeverity.critical++; break;
          case 'HIGH': vulnerabilitiesBySeverity.high++; break;
          case 'MEDIUM': vulnerabilitiesBySeverity.medium++; break;
          case 'LOW': vulnerabilitiesBySeverity.low++; break;
        }
      }
    }

    const plan: ExecutionPlan = {
      id: randomUUID(),
      projectId,
      tasks,
      batches,
      estimatedDuration,
      riskAssessment,
      summary: this.generateSummary(tasks, components),
      createdAt: new Date().toISOString(),
      policyUsed: this.policyEngine.getPolicy(),
      vulnerabilitiesBySeverity,
    };

    log.info(`Plan created with ${tasks.length} tasks in ${batches.length} batches`);
    return plan;
  }

  // Create tasks for a single component
  private async createTasksForComponent(
    component: Component,
    graph: DependencyGraph
  ): Promise<RemediationTask[]> {
    const tasks: RemediationTask[] = [];

    // Find the node in the graph
    const packageUrl = component.packageUrl;
    const node = graph.nodes.get(packageUrl);

    // Determine if it's a direct dependency
    const isDirect = node?.isDirect ?? graph.directDependencies.includes(packageUrl);
    const isManagedBySpringBoot = node?.isManagedBySpringBoot ?? false;
    const isUnused = node ? !node.isUsed : false;

    // Spring Boot Rule: if a dependency is managed by Spring Boot, DO NOT
    // override it individually. The dedicated Spring Boot upgrade task handles
    // it. Creating a per-component task here would set the parent version to
    // the component's own version and corrupt the POM.
    if (isManagedBySpringBoot) {
      log.info(
        `Skipping ${component.groupId}:${component.artifactId} — managed by Spring Boot, covered by parent upgrade`
      );
      return tasks;
    }

    // Get target version from IQ suggestion or Nexus search
    const targetVersion = await this.findBestVersion(component);

    if (!targetVersion) {
      log.warn(`No valid target version found for ${component.groupId}:${component.artifactId}`);
      return tasks;
    }

    // Determine priority
    const priority = this.policyEngine.determinePriority(
      component,
      node ?? undefined,
      isManagedBySpringBoot,
      isDirect,
      isUnused
    );

    // Create task
    const task = this.policyEngine.createTask(
      component,
      priority,
      targetVersion,
      this.getTaskDependencies(component, graph)
    );

    tasks.push(task);

    return tasks;
  }

  // Create a Spring Boot parent upgrade task
  // Finds the best target version from IQ suggestions across Spring Boot managed components
  private createSpringBootUpgradeTask(
    currentBootVersion: string,
    components: Component[],
  ): RemediationTask | null {
    // Collect all suggested versions from Spring Boot managed components
    const suggestedVersions: string[] = [];
    for (const comp of components) {
      for (const vuln of comp.vulnerabilities) {
        if (vuln.suggestedVersion) {
          suggestedVersions.push(vuln.suggestedVersion);
        }
      }
    }

    // Find the highest suggested version that's newer than current
    let targetVersion: string | null = null;
    const sorted = suggestedVersions.sort((a, b) => compareVersions(b, a));
    for (const v of sorted) {
      if (compareVersions(v, currentBootVersion) > 0) {
        const evaluation = this.policyEngine.evaluateIQSuggestion(v, currentBootVersion);
        if (evaluation.accepted) {
          targetVersion = v;
          break;
        }
      }
    }

    if (!targetVersion) {
      log.warn(`No valid Spring Boot upgrade target found from ${currentBootVersion}`);
      return null;
    }

    // Count how many vulnerabilities this upgrade would fix
    const expectedFixes: string[] = [];
    for (const comp of components) {
      for (const vuln of comp.vulnerabilities) {
        expectedFixes.push(vuln.id);
      }
    }

    return {
      id: randomUUID(),
      priority: 'upgrade-spring-boot-parent',
      description: `Upgrade Spring Boot ${currentBootVersion} → ${targetVersion}`,
      component: {
        groupId: 'org.springframework.boot',
        artifactId: 'spring-boot-starter-parent',
        currentVersion: currentBootVersion,
        targetVersion,
      },
      reason: `Spring Boot upgrade addresses ${expectedFixes.length} managed dependency vulnerabilities`,
      expectedFixes,
      confidence: 'high',
      risk: 'medium',
      preconditions: ['Project builds successfully', 'Verify Spring Boot compatibility'],
      verification: ['Run mvn clean verify', 'Run IQ scan to verify vulnerabilities resolved'],
      rollbackSteps: ['Restore pom.xml from backup', 'Verify build succeeds after rollback'],
      dependencies: [],
      status: 'pending',
    };
  }

  // Find best version for a component
  private async findBestVersion(component: Component): Promise<string | null> {
    // First, check IQ suggestions
    for (const vuln of component.vulnerabilities) {
      if (vuln.suggestedVersion) {
        const evaluation = this.policyEngine.evaluateIQSuggestion(
          vuln.suggestedVersion,
          component.version
        );
        if (evaluation.accepted) {
          return vuln.suggestedVersion;
        }
      }
    }

    // Check fix versions from vulnerabilities — use proper semver comparison
    for (const vuln of component.vulnerabilities) {
      if (vuln.fixVersions && vuln.fixVersions.length > 0) {
        // Sort a COPY of fix versions descending (newest first) — avoid mutating the original
        const sorted = [...vuln.fixVersions].sort((a, b) => compareVersions(b, a));

        // Check each fix version
        for (const fixVersion of sorted) {
          const evaluation = this.policyEngine.evaluateIQSuggestion(fixVersion, component.version);
          if (evaluation.accepted) {
            return fixVersion;
          }
        }
      }
    }

    // Fall back to Nexus search if no IQ suggestion was accepted
    if (this.nexusWorker) {
      try {
        const policy = this.policyEngine.getPolicy();
        const result = await this.nexusWorker.suggestUpgrade(
          component.groupId,
          component.artifactId,
          component.version,
          {
            allowMinor: policy.allowMinor,
            allowMajor: policy.allowMajor,
            allowSnapshots: policy.allowSnapshots,
            allowPreRelease: false,
            allowRedHat: policy.allowRedhat,
          }
        );
        if (result.suggested) {
          log.info(`Nexus suggested upgrade for ${component.groupId}:${component.artifactId}: ${component.version} → ${result.suggested} (${result.type})`);
          return result.suggested;
        }
      } catch (error) {
        log.warn(`Nexus search failed for ${component.groupId}:${component.artifactId}: ${error}`);
      }
    }

    return null;
  }

  // Get task dependencies — analyzes the dependency graph to determine
  // which remediation tasks must complete before others
  private getTaskDependencies(
    component: Component,
    graph: DependencyGraph
  ): string[] {
    const dependencies: string[] = [];

    // If this component is managed by Spring Boot, the Spring Boot upgrade
    // task should complete first (but we don't create that task here)
    // This is handled by the priority ordering

    // If this is a transitive dependency, find if the owning direct dependency
    // also has vulnerabilities that need fixing first
    const node = graph.nodes.get(component.packageUrl);
    if (node && !node.isDirect) {
      // Check if any parent in the import chain is also vulnerable
      // and would be upgraded in a separate task
      for (const parentUrl of node.importedBy) {
        const parentNode = graph.nodes.get(parentUrl);
        if (parentNode && parentNode.vulnerabilities.length > 0) {
          // The parent upgrade should happen first — but we need to find
          // the task ID for that parent. Since tasks haven't been assigned IDs yet
          // during dependency resolution, we use the packageUrl as a temporary key.
          // The buildBatches method will resolve these after all tasks are created.
          // Store as a marker that will be resolved later
          dependencies.push(`depends-on:${parentUrl}`);
        }
      }
    }

    return dependencies;
  }

  // Resolve dependency markers into actual task IDs
  private resolveDependencyMarkers(
    tasks: RemediationTask[],
    _graph: DependencyGraph
  ): void {
    // Build a map from groupId:artifactId to task ID
    // This handles version mismatches between graph nodes and task components
    const artifactToTaskId = new Map<string, string>();
    for (const task of tasks) {
      const key = `${task.component.groupId}:${task.component.artifactId}`;
      artifactToTaskId.set(key, task.id);
    }

    // Also build a full packageUrl map for exact matches
    const urlToTaskId = new Map<string, string>();
    for (const task of tasks) {
      const url = `pkg:maven/${task.component.groupId}/${task.component.artifactId}@${task.component.currentVersion}`;
      urlToTaskId.set(url, task.id);
    }

    // Resolve markers
    for (const task of tasks) {
      task.dependencies = task.dependencies
        .map(dep => {
          if (dep.startsWith('depends-on:')) {
            const url = dep.slice('depends-on:'.length);
            // Try exact match first
            const taskId = urlToTaskId.get(url);
            if (taskId) return taskId;

            // Fall back to groupId:artifactId match
            // Parse groupId and artifactId from pkg:maven/groupId/artifactId@version
            const match = url.match(/^pkg:maven\/([^/]+)\/([^@]+)@/);
            if (match) {
              const key = `${match[1]}:${match[2]}`;
              return artifactToTaskId.get(key) || null;
            }
            return null;
          }
          return dep;
        })
        .filter((dep): dep is string => dep !== null);
    }
  }

  // Build batches for parallel execution using topological sort
  private buildBatches(tasks: RemediationTask[]): RemediationTask[][] {
    const batches: RemediationTask[][] = [];
    const processed = new Set<string>();

    // Iterative topological sort with batching
    // Each iteration finds all tasks whose dependencies are satisfied
    while (processed.size < tasks.length) {
      const batch: RemediationTask[] = [];

      // Find tasks with no unprocessed dependencies
      for (const task of tasks) {
        if (processed.has(task.id)) continue;

        const allProcessed = task.dependencies.every(d => processed.has(d));
        if (allProcessed) {
          batch.push(task);
        }
      }

      if (batch.length === 0) {
        // No progress possible — circular dependency or dangling reference
        const remaining = tasks.filter(t => !processed.has(t.id));
        log.error(
          `Circular dependency or dangling reference detected. ` +
          `${remaining.length} task(s) cannot be scheduled: ` +
          remaining.map(t => `${t.id} (${t.description})`).join(', ')
        );

        // Mark remaining tasks as skipped so they appear in the plan
        for (const task of remaining) {
          task.status = 'skipped';
          processed.add(task.id);
        }
        break;
      }

      // Mark batch as processed
      for (const task of batch) {
        processed.add(task.id);
      }

      batches.push(batch);
    }

    return batches;
  }

  // Calculate risk assessment
  private calculateRiskAssessment(tasks: RemediationTask[]): 'low' | 'medium' | 'high' {
    if (tasks.some(t => t.risk === 'high')) return 'high';
    if (tasks.some(t => t.risk === 'medium')) return 'medium';
    return 'low';
  }

  // Estimate duration
  private estimateDuration(batches: RemediationTask[][]): string {
    // Rough estimate: 2 minutes per batch for builds/scans
    const estimatedMinutes = batches.length * 2;

    if (estimatedMinutes < 5) return 'less than 5 minutes';
    if (estimatedMinutes < 15) return '5-15 minutes';
    if (estimatedMinutes < 30) return '15-30 minutes';
    return 'more than 30 minutes';
  }

  // Generate summary
  private generateSummary(tasks: RemediationTask[], components: Component[]): string {
    const totalVulnerabilities = components.reduce(
      (sum, c) => sum + c.vulnerabilities.length,
      0
    );
    const highPriority = tasks.filter(t => t.priority === 'upgrade-spring-boot-parent').length;
    const mediumPriority = tasks.filter(t =>
      t.priority === 'upgrade-owning-direct-dependency' ||
      t.priority === 'upgrade-direct-dependency'
    ).length;

    return `Plan addresses ${totalVulnerabilities} vulnerabilities across ${components.length} components with ${tasks.length} tasks (${highPriority} high priority, ${mediumPriority} medium priority)`;
  }

  // Count Spring Boot managed components
  private countSpringBootManaged(components: Component[]): number {
    const graph = this.graphBuilder.getGraph();
    let count = 0;

    for (const component of components) {
      const node = graph.nodes.get(component.packageUrl);
      if (node?.isManagedBySpringBoot) {
        count++;
      }
    }

    return count;
  }

  // Replan after batch execution
  async replan(
    currentPlan: ExecutionPlan,
    completedTasks: string[],
    remainingVulnerabilities: Component[]
  ): Promise<ExecutionPlan> {
    log.info(`Replanning after ${completedTasks.length} completed tasks`);

    // Filter out completed tasks
    const remainingTasks = currentPlan.tasks.filter(
      t => !completedTasks.includes(t.id) && t.status !== 'completed'
    );

    // Create new plan with remaining vulnerabilities
    const newPlan = await this.createPlan(remainingVulnerabilities, currentPlan.projectId);

    // Merge with existing tasks
    const mergedTasks = [...remainingTasks, ...newPlan.tasks];
    const batches = this.buildBatches(mergedTasks);

    return {
      ...newPlan,
      id: randomUUID(),  // New plan ID — old ExecutionState still references the old plan
      previousPlanId: currentPlan.id,  // Track lineage for audit
      tasks: mergedTasks,
      batches,
      summary: `Replan: ${remainingTasks.length} remaining + ${newPlan.tasks.length} new tasks`,
    };
  }

  // Validate plan
  validatePlan(plan: ExecutionPlan): string[] {
    const errors: string[] = [];

    // Check for circular dependencies
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (taskId: string): boolean => {
      visited.add(taskId);
      recursionStack.add(taskId);

      const task = plan.tasks.find(t => t.id === taskId);
      if (task) {
        for (const dep of task.dependencies) {
          if (!visited.has(dep)) {
            if (hasCycle(dep)) return true;
          } else if (recursionStack.has(dep)) {
            return true;
          }
        }
      }

      recursionStack.delete(taskId);
      return false;
    };

    for (const task of plan.tasks) {
      if (!visited.has(task.id)) {
        if (hasCycle(task.id)) {
          errors.push(`Circular dependency detected involving task ${task.id}`);
        }
      }
    }

    // Check all dependencies exist
    for (const task of plan.tasks) {
      for (const dep of task.dependencies) {
        if (!plan.tasks.some(t => t.id === dep)) {
          errors.push(`Task ${task.id} depends on non-existent task ${dep}`);
        }
      }
    }

    return errors;
  }
}
