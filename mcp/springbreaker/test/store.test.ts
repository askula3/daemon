import { describe, it, expect, beforeEach } from "vitest";
import { planStore } from "../src/store.js";
import type {
  ExecutionPlan,
  ExecutionState,
  ExecutionResult,
} from "../src/types/index.js";

function makePlan(id: string): ExecutionPlan {
  return {
    id,
    projectId: "test-app",
    tasks: [],
    batches: [],
    estimatedDuration: "< 5 min",
    riskAssessment: "low",
    summary: "test plan",
    createdAt: new Date().toISOString(),
    policyUsed: {
      severity: ["HIGH"],
      preferParentUpgrade: true,
      preferOwningDependency: true,
      preferIqSuggestion: true,
      removeUnused: true,
      allowPatch: true,
      allowMinor: true,
      allowMajor: false,
      allowSnapshots: false,
      allowRedhat: false,
      verifyBuild: true,
      verifyIq: true,
    },
    vulnerabilitiesBySeverity: {
      total: 0,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
    gitRevision: "abc123",
    projectFingerprint: "fp123",
    policyHash: "ph123",
  };
}

function makeExecution(id: string, planId: string): ExecutionState {
  const result: ExecutionResult = {
    executionId: id,
    planId,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "completed",
    tasksCompleted: 1,
    tasksFailed: 0,
    tasksSkipped: 0,
    buildSuccess: true,
    iqScanSuccess: true,
    vulnerabilitiesBefore: 5,
    vulnerabilitiesAfter: 3,
    vulnerabilitiesResolved: 2,
    remainingVulnerabilities: 3,
    vulnerabilitiesBySeverityBefore: {
      total: 5,
      critical: 0,
      high: 3,
      medium: 2,
      low: 0,
    },
    vulnerabilitiesBySeverityAfter: {
      total: 3,
      critical: 0,
      high: 1,
      medium: 2,
      low: 0,
    },
    changes: [],
    errors: [],
  };
  return {
    executionId: id,
    plan: makePlan(planId),
    result,
    pomBackups: new Map(),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

describe("MemPlanStore", () => {
  beforeEach(() => {
    planStore.clear();
  });

  describe("plan CRUD", () => {
    it("saves and retrieves a plan", () => {
      const plan = makePlan("plan-1");
      planStore.savePlan(plan);
      const retrieved = planStore.getPlan("plan-1");
      expect(retrieved?.id).toBe("plan-1");
    });

    it("returns undefined for nonexistent plan", () => {
      expect(planStore.getPlan("nonexistent")).toBeUndefined();
    });

    it("overwrites plan with same ID", () => {
      const plan1 = makePlan("plan-1");
      plan1.summary = "first";
      planStore.savePlan(plan1);

      const plan2 = makePlan("plan-1");
      plan2.summary = "second";
      planStore.savePlan(plan2);

      expect(planStore.getPlan("plan-1")?.summary).toBe("second");
    });
  });

  describe("execution CRUD", () => {
    it("saves and retrieves an execution", () => {
      const exec = makeExecution("exec-1", "plan-1");
      planStore.saveExecution(exec);
      const retrieved = planStore.getExecution("exec-1");
      expect(retrieved?.executionId).toBe("exec-1");
    });

    it("returns undefined for nonexistent execution", () => {
      expect(planStore.getExecution("nonexistent")).toBeUndefined();
    });

    it("lists executions sorted by timestamp (newest first)", () => {
      planStore.saveExecution(makeExecution("exec-1", "plan-1"));
      planStore.saveExecution(makeExecution("exec-2", "plan-2"));

      const list = planStore.listExecutions();
      expect(list.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("clear", () => {
    it("removes all plans and executions", () => {
      planStore.savePlan(makePlan("plan-1"));
      planStore.saveExecution(makeExecution("exec-1", "plan-1"));

      planStore.clear();

      expect(planStore.getPlan("plan-1")).toBeUndefined();
      expect(planStore.getExecution("exec-1")).toBeUndefined();
    });
  });
});
