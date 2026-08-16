import { z } from "zod";

const ProjectPathSchema = z.string().trim().min(1).max(4096)
  .describe("Canonicalizable path to the Maven project root");

export const InspectProjectSchema = z.object({
  projectPath: ProjectPathSchema,
}).strict();

export const BuildPlanSchema = z.object({
  projectPath: ProjectPathSchema,
  severity: z.array(z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]))
    .min(1).optional().describe("Severity levels to address"),
  policy: z.object({
    allowPatch: z.boolean().optional(),
    allowMinor: z.boolean().optional(),
    allowMajor: z.boolean().optional(),
    allowSnapshots: z.boolean().optional(),
    allowRedhat: z.boolean().optional(),
    verifyBuild: z.boolean().optional(),
    verifyIq: z.boolean().optional(),
    maxBatchSize: z.number().int().positive().max(100).optional(),
    timeout: z.number().int().positive().max(3_600_000).optional(),
  }).strict().optional().describe("Validated policy overrides for this plan"),
}).strict().describe("Build an immutable vulnerability remediation plan");

export const ExecutePlanSchema = z.object({
  projectPath: ProjectPathSchema,
  planId: z.string().uuid().describe("ID of the immutable plan to execute"),
  approvedTasks: z.array(z.string().uuid()).min(1).max(100).optional()
    .describe("Explicit non-empty list of approved task IDs"),
  approveAll: z.boolean().optional().default(false)
    .describe("Explicitly approve every task in the plan"),
  dryRun: z.boolean().optional().default(false)
    .describe("Preview approved changes without modifying files"),
  commit: z.boolean().optional().default(false)
    .describe("Commit only SpringBreaker-modified POMs after success"),
  createBranch: z.boolean().optional().default(false)
    .describe("Create a feature branch before modifying files"),
}).strict().describe("Execute explicitly approved tasks from an immutable plan");

export const VerifySchema = z.object({
  projectPath: ProjectPathSchema,
  skipBuild: z.boolean().optional().default(false).describe("Skip Maven build verification"),
  skipIq: z.boolean().optional().default(false).describe("Skip IQ scan verification"),
  compareWithExecutionId: z.string().uuid().optional()
    .describe("Execution ID to compare against for a before/after delta"),
}).strict().describe("Verify the build and run a fresh IQ scan");

export const SummarizeSchema = z.object({
  projectPath: ProjectPathSchema,
  executionId: z.string().uuid().describe("ID of the execution to summarize"),
}).strict().describe("Generate a project-bound execution summary");
