// Barrel file — imports from individual tool modules
import { inspectProject } from './inspect-project.js';
import { buildPlan } from './build-plan.js';
import { executePlan } from './execute-plan.js';
import { verify } from './verify.js';
import { summarize } from './summarize.js';
import {
  InspectProjectSchema,
  BuildPlanSchema,
  ExecutePlanSchema,
  VerifySchema,
  SummarizeSchema,
} from './schemas.js';

// Re-export individual tools for direct import
export { inspectProject } from './inspect-project.js';
export { buildPlan } from './build-plan.js';
export { executePlan } from './execute-plan.js';
export { verify } from './verify.js';
export { summarize } from './summarize.js';
export { analyzeProjectUsage, buildProjectInfo } from './project-info.js';
export {
  InspectProjectSchema,
  BuildPlanSchema,
  ExecutePlanSchema,
  VerifySchema,
  SummarizeSchema,
} from './schemas.js';

// Export all tools with schemas for MCP server registration
export const tools = [
  {
    name: "inspect_project",
    title: "Inspect Maven Project",
    description:
      "Safely inspect a Maven project's POM structure, modules, Git state, and configured capabilities. Does not run Maven or modify project files.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: InspectProjectSchema,
    handler: inspectProject,
  },
  {
    name: "build_plan",
    title: "Build Remediation Plan",
    description:
      "Generate an ephemeral CycloneDX SBOM, scan it with Sonatype IQ, and build a deterministic, immutable remediation plan. Runs Maven and calls configured external services, but does not edit POM files.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: BuildPlanSchema,
    handler: buildPlan,
  },
  {
    name: "execute_plan",
    title: "Execute Remediation Plan",
    description: "Apply an approved immutable plan in verified batches. POM edits are transactional; failed build or IQ verification rolls back the current batch. Git branch and commit operations are opt-in.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: ExecutePlanSchema,
    handler: executePlan,
  },
  {
    name: "verify",
    title: "Verify Remediation",
    description:
      "Run Maven clean verify and a fresh CycloneDX IQ scan, optionally comparing the verified result with a stored execution.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: VerifySchema,
    handler: verify,
  },
  {
    name: "summarize",
    title: "Summarize Execution",
    description: "Read a stored execution and return a project-bound remediation summary with verified outcomes and follow-up recommendations.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: SummarizeSchema,
    handler: summarize,
  },
];
