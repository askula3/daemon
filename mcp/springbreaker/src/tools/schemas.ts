import { z } from "zod";

// Schema for inspect_project
export const InspectProjectSchema = z.object({
  projectPath: z.string().describe("Path to the Maven project root"),
});

// Schema for build_plan
export const BuildPlanSchema = z
  .object({
    projectPath: z.string().describe("Path to the Maven project root"),
    severity: z
      .array(z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]))
      .optional()
      .describe("Severity levels to address"),
    policy: z
      .object({
        allowPatch: z.boolean().optional(),
        allowMinor: z.boolean().optional(),
        allowMajor: z.boolean().optional(),
        allowSnapshots: z.boolean().optional(),
        allowRedhat: z.boolean().optional(),
      })
      .optional()
      .describe("Policy overrides"),
  })
  .describe("Build an execution plan for vulnerability remediation");

// Schema for execute_plan
export const ExecutePlanSchema = z
  .object({
    projectPath: z.string().describe("Path to the Maven project root"),
    planId: z.string().describe("ID of the plan to execute"),
    approvedTasks: z
      .array(z.string())
      .optional()
      .describe("Task IDs to execute (empty = all)"),
  })
  .describe("Execute an approved remediation plan");

// Schema for verify
export const VerifySchema = z
  .object({
    projectPath: z.string().describe("Path to the Maven project root"),
  })
  .describe("Verify build and run IQ scan");

// Schema for summarize
export const SummarizeSchema = z
  .object({
    projectPath: z.string().describe("Path to the Maven project root"),
    executionId: z.string().describe("ID of the execution to summarize"),
  })
  .describe("Generate summary of remediation results");
