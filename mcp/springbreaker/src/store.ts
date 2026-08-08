import { createChildLogger } from './utils/logger.js';
import type { ExecutionPlan, ExecutionState, IPlanStore } from './types/index.js';

const log = createChildLogger('PlanStore');

// Maximum number of plans and executions to keep in memory.
// Prevents unbounded memory growth in long-running MCP server processes.
const MAX_PLANS = 50;
const MAX_EXECUTIONS = 100;

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

    this.plans.set(plan.id, { plan, timestamp: Date.now() });
    log.debug(`Plan saved: ${plan.id} (${plan.tasks.length} tasks)`);
  }

  getPlan(planId: string): ExecutionPlan | undefined {
    const entry = this.plans.get(planId);
    if (entry) {
      // Bump timestamp on access (approximate LRU)
      entry.timestamp = Date.now();
      return entry.plan;
    }
    return undefined;
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

    this.executions.set(state.executionId, { state, timestamp: Date.now() });
    log.debug(`Execution saved: ${state.executionId} (status: ${state.result.status})`);
  }

  getExecution(executionId: string): ExecutionState | undefined {
    const entry = this.executions.get(executionId);
    if (entry) {
      entry.timestamp = Date.now();
      return entry.state;
    }
    return undefined;
  }

  listExecutions(): ExecutionState[] {
    return [...this.executions.values()]
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(e => e.state);
  }

  /** Remove all plans and executions (for testing). */
  clear(): void {
    this.plans.clear();
    this.executions.clear();
    log.debug('Store cleared');
  }
}

/** Singleton store — survives across tool calls within the same server process. */
export const planStore: IPlanStore = new MemPlanStore();
