import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const client = new Client({ name: "springbreaker-build-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: packageRoot,
  stderr: "pipe",
});

try {
  await client.connect(transport);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["inspect_project", "build_plan", "execute_plan", "verify", "summarize"],
  );
  assert.equal(client.getServerVersion()?.name, "springbreaker");
} finally {
  await client.close();
}
