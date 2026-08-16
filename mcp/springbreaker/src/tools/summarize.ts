import { z } from "zod";
import { createChildLogger } from "../utils/logger.js";
import { handleToolError, POMError } from "../utils/errors.js";
import { planStore } from "../store.js";
import { SummarizeSchema } from "./schemas.js";
import { resolveProjectPath } from "../utils/project-path.js";
import type { ToolContext } from "./context.js";

const log = createChildLogger("Summarize");

// Tool: summarize
export async function summarize(
  args: z.infer<typeof SummarizeSchema>,
  _context?: ToolContext,
): Promise<{
  content: { type: "text"; text: string }[];
}> {
  try {
    const { executionId } = args;
    const projectPath = await resolveProjectPath(args.projectPath);
    log.info(`Summarizing execution ${executionId} for: ${projectPath}`);

    // Look up execution from store
    const state = planStore.getExecution(executionId);
    if (!state) {
      throw new POMError(
        `Execution not found: ${executionId}. It may have been from a previous server session.`,
      );
    }

    const { result, plan } = state;
    if (plan.projectPath !== projectPath) {
      throw new POMError(`Execution ${executionId} does not belong to project: ${projectPath}`);
    }

    // Count changes by type
    const upgraded = result.changes.filter((c) => c.type === "upgrade").length;
    const added = result.changes.filter((c) => c.type === "add").length;
    const removed = result.changes.filter((c) => c.type === "remove").length;
    const excluded = result.changes.filter((c) => c.type === "exclude").length;
    const pomFiles = [...new Set(result.changes.map((c) => c.pomPath))];

    // Generate recommendations
    const recommendations: string[] = [];
    if (result.tasksFailed > 0) {
      recommendations.push(
        `${result.tasksFailed} task(s) failed — review errors and retry manually`,
      );
    }
    if (result.remainingVulnerabilities > 0) {
      recommendations.push(
        `${result.remainingVulnerabilities} vulnerabilities remain — consider relaxing policy or manual intervention`,
      );
    }
    if (result.tasksSkipped > 0) {
      recommendations.push(
        `${result.tasksSkipped} task(s) were skipped due to unsatisfied dependencies`,
      );
    }

    const summary = {
      projectId: plan.projectId,
      executionId: result.executionId,
      timestamp: new Date().toISOString(),
      initialVulnerabilities: result.vulnerabilitiesBySeverityBefore,
      finalVulnerabilities: result.vulnerabilitiesBySeverityAfter,
      resolvedVulnerabilities: {
        total: result.vulnerabilitiesResolved,
        critical: result.vulnerabilitiesBySeverityBefore.critical - result.vulnerabilitiesBySeverityAfter.critical,
        high: result.vulnerabilitiesBySeverityBefore.high - result.vulnerabilitiesBySeverityAfter.high,
        medium: result.vulnerabilitiesBySeverityBefore.medium - result.vulnerabilitiesBySeverityAfter.medium,
        low: result.vulnerabilitiesBySeverityBefore.low - result.vulnerabilitiesBySeverityAfter.low,
      },
      changes: {
        dependenciesUpgraded: upgraded,
        dependenciesAdded: added,
        dependenciesRemoved: removed,
        exclusionsAdded: excluded,
        pomFilesModified: pomFiles,
      },
      buildStatus: result.buildSuccess ? "success" : "failure",
      recommendations,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  } catch (error) {
    return handleToolError(error);
  }
}
