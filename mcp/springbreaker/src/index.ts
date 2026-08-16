#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from "./utils/logger.js";
import { tools } from "./tools/index.js";
import { z } from "zod";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadEnvConfig } from "./config.js";
import { handleToolError } from "./utils/errors.js";

// Create MCP server
const server = new McpServer(
  {
    name: "springbreaker",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "SpringBreaker deterministically remediates Spring Boot Maven vulnerabilities. " +
      "Use inspect_project first, build_plan second, review and approve task IDs, then call execute_plan. " +
      "Use verify for an independent final check and summarize for the stored audit summary. " +
      "execute_plan edits POM files; branch and commit remain opt-in.",
  },
);

const ToolEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.record(z.unknown()).optional(),
  error: z.record(z.unknown()).optional(),
});

// Register all tools with type-safe handlers
for (const tool of tools) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: ToolEnvelopeSchema,
      annotations: tool.annotations,
    },
    async (
      args: Record<string, unknown>,
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ) => {
      logger.info(`Tool called: ${tool.name}`);
      const progressToken = extra._meta?.progressToken;
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: 0, total: 100, message: `Starting ${tool.name}` },
        });
      }
      // Parse and validate args through the schema for type safety
      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) {
        const error = {
          error: "VALIDATION_ERROR",
          message: parsed.error.message,
          issues: parsed.error.issues,
        };
        const envelope = { ok: false, error };
        if (progressToken !== undefined) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: 100, total: 100, message: `Rejected ${tool.name}` },
          });
        }
        return {
          isError: true,
          structuredContent: envelope,
          content: [{
            type: "text" as const,
            text: JSON.stringify(envelope, null, 2),
          }],
        };
      }
      // Use type assertion — the schema guarantees the shape matches the handler
      let result: {
        content: { type: "text"; text: string }[];
        isError?: boolean;
      };
      try {
        result = await tool.handler(parsed.data as never, {
          signal: extra.signal,
          progress: progressToken === undefined
            ? undefined
            : async (progress, total, message) => {
                await extra.sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: Math.min(90, Math.round((progress / Math.max(total, 1)) * 90)),
                    total: 100,
                    message,
                  },
                });
              },
        });
      } catch (error) {
        // Defense in depth: individual tools normalize errors, but an
        // unexpected exception must never tear down the long-running server.
        result = handleToolError(error);
      }
      let payload: Record<string, unknown>;
      let isError = result.isError === true;
      try {
        payload = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
      } catch {
        payload = {
          error: "INVALID_TOOL_RESPONSE",
          message: `${tool.name} returned a non-JSON response`,
          recoverable: false,
        };
        isError = true;
      }
      const envelope = isError
        ? { ok: false, error: payload }
        : { ok: true, data: payload };
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: 100, total: 100, message: `Completed ${tool.name}` },
        });
      }
      return {
        ...result,
        structuredContent: envelope,
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
      };
    },
  );
}

// Start server
async function main() {
  // Apply trusted process/package configuration before emitting startup logs.
  logger.setLevel(loadEnvConfig().logLevel);
  logger.info("⚡ Starting SpringBreaker MCP Server");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP Server running on stdio");
}

// Graceful shutdown handler
function setupShutdownHandlers() {
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await server.close();
    } catch {
      // Ignore errors during shutdown
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

setupShutdownHandlers();
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Failed to start MCP server: ${message}`);
  process.exit(1);
});
