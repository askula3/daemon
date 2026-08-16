import { createChildLogger } from './utils/logger.js';
import type { ExecutionPlan, ExecutionState, IPlanStore } from './types/index.js';

const log = createChildLogger('PlanStore');

// Maximum number of plans and executions to keep in memory.
// Prevents unbounded memory growth in long-running MCP server processes.
const MAX_PLANS = 50;
const MAX_EXECUTIONS = 100;
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
const EXECUTION_TTL_MS = 7 * PLAN_TTL_MS;

/**
 * In-memory plan and execution store with LRU-like eviction.
 *
 * Plans and execution states are kept for the lifetime of the MCP server
 * process. If the server restarts, all state is lost — this is acceptable
 * because the AI can simply re-run build_plan / execute_plan.
 *
 * When the store exceeds capacity, the oldest entries are evicted first.
 */
class MemPlanStore implements IPlanStore {
  private plans = new Map<string, { plan: ExecutionPlan; timestamp: number }>();
  private executions = new Map<string, { state: ExecutionState; timestamp: number }>();
  private claimedPlans = new Set<string>();

  savePlan(plan: ExecutionPlan): void {
    // Evict oldest if at capacity
    if (this.plans.size >= MAX_PLANS) {
      const oldest = [...this.plans.entries()].sort(
        (a, b) => a[1].timestamp - b[1].timestamp,
      )[0];
      if (oldest) {
        this.plans.delete(oldest[0]);
        log.debug(`Evicted oldest plan: ${oldest[0]}`);
      }
    }

    this.plans.set(plan.id, { plan: structuredClone(plan), timestamp: Date.now() });
    log.debug(`Plan saved: ${plan.id} (${plan.tasks.length} tasks)`);
  }

  getPlan(planId: string): ExecutionPlan | undefined {
    const entry = this.plans.get(planId);
    if (entry) {
      if (Date.now() - entry.timestamp > PLAN_TTL_MS) {
        this.plans.delete(planId);
        this.claimedPlans.delete(planId);
        return undefined;
      }
      // Bump timestamp on access (approximate LRU)
      entry.timestamp = Date.now();
      return structuredClone(entry.plan);
    }
    return undefined;
  }

  claimPlan(planId: string): boolean {
    if (!this.getPlan(planId) || this.claimedPlans.has(planId)) return false;
    this.claimedPlans.add(planId);
    return true;
  }

  saveExecution(state: ExecutionState): void {
    // Evict oldest if at capacity
    if (this.executions.size >= MAX_EXECUTIONS) {
      const oldest = [...this.executions.entries()].sort(
        (a, b) => a[1].timestamp - b[1].timestamp,
      )[0];
      if (oldest) {
        this.executions.delete(oldest[0]);
        log.debug(`Evicted oldest execution: ${oldest[0]}`);
      }
    }

    this.executions.set(state.executionId, { state: structuredClone(state), timestamp: Date.now() });
    log.debug(`Execution saved: ${state.executionId} (status: ${state.result.status})`);
  }

  getExecution(executionId: string): ExecutionState | undefined {
    const entry = this.executions.get(executionId);
    if (entry) {
      if (Date.now() - entry.timestamp > EXECUTION_TTL_MS) {
        this.executions.delete(executionId);
        return undefined;
      }
      entry.timestamp = Date.now();
      return structuredClone(entry.state);
    }
    return undefined;
  }

  listExecutions(): ExecutionState[] {
    const now = Date.now();
    for (const [executionId, entry] of this.executions) {
      if (now - entry.timestamp > EXECUTION_TTL_MS) this.executions.delete(executionId);
    }
    return [...this.executions.values()]
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(e => structuredClone(e.state));
  }

  /** Remove all plans and executions (for testing). */
  clear(): void {
    this.plans.clear();
    this.executions.clear();
    this.claimedPlans.clear();
    log.debug('Store cleared');
  }
}

/** Singleton store — survives across tool calls within the same server process. */
export const planStore: IPlanStore = new MemPlanStore();
