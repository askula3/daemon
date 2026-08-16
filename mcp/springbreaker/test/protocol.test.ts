import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

describe("MCP stdio protocol", () => {
  const client = new Client({ name: "springbreaker-protocol-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const progress: number[] = [];

  beforeAll(async () => {
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      progress.push(notification.params.progress);
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
  });

  it("advertises instructions, five strict tools, output schemas, and annotations", async () => {
    expect(client.getServerVersion()).toMatchObject({ name: "springbreaker", version: "1.0.0" });
    expect(client.getInstructions()).toContain("review and approve task IDs");

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "inspect_project", "build_plan", "execute_plan", "verify", "summarize",
    ]);
    for (const tool of listed.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      expect((tool as typeof tool & { title?: string }).title).toBeTruthy();
    }
    expect(listed.tools.find((tool) => tool.name === "execute_plan")?.annotations)
      .toMatchObject({ destructiveHint: true, idempotentHint: false });
  });

  it("returns MCP-visible validation errors with conforming structured output and progress", async () => {
    const result = await client.callTool({
      name: "inspect_project",
      arguments: { projectPath: "/definitely/not/a/springbreaker/project" },
      _meta: { progressToken: "validation-test" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { error: "VALIDATION_ERROR" },
    });
    expect(progress).toEqual(expect.arrayContaining([0, 100]));
  });
});
