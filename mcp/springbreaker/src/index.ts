#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from "./utils/logger.js";
import { tools } from "./tools/index.js";

// Create MCP server
const server = new McpServer(
  {
    name: "springbreaker",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  },
);

// Register all tools with type-safe handlers
for (const tool of tools) {
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema.shape,
    async (args: Record<string, unknown>) => {
      logger.info(`Tool called: ${tool.name}`);
      // Parse and validate args through the schema for type safety
      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "VALIDATION_ERROR",
              message: parsed.error.message,
              issues: parsed.error.issues,
            }, null, 2),
          }],
        };
      }
      // Use type assertion — the schema guarantees the shape matches the handler
      const result = await tool.handler(parsed.data as never);
      return result;
    },
  );
}

// Start server
async function main() {
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
  logger.error("Failed to start MCP server:", error);
  process.exit(1);
});
