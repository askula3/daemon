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
export { buildProjectInfo } from './project-info.js';
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
    description:
      "Inspect a Maven project and gather information about its structure, dependencies, and capabilities",
    inputSchema: InspectProjectSchema,
    handler: inspectProject,
  },
  {
    name: "build_plan",
    description:
      "Build an execution plan for remediating vulnerabilities in a Maven project",
    inputSchema: BuildPlanSchema,
    handler: buildPlan,
  },
  {
    name: "execute_plan",
    description: "Execute an approved remediation plan",
    inputSchema: ExecutePlanSchema,
    handler: executePlan,
  },
  {
    name: "verify",
    description:
      "Verify the build and run IQ scan to check for remaining vulnerabilities",
    inputSchema: VerifySchema,
    handler: verify,
  },
  {
    name: "summarize",
    description: "Generate a summary of the remediation execution results",
    inputSchema: SummarizeSchema,
    handler: summarize,
  },
];
