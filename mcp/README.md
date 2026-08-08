# MCP Servers

This directory contains multiple Model Context Protocol (MCP) servers.

Each MCP is isolated in its own subfolder with independent dependencies, configuration, and build setup.

## Available MCPs

| MCP | Description |
|-----|-------------|
| [springbreaker/](./springbreaker/) | ⚡ Breaks through Spring Boot dependency vulnerabilities via IQ Server, Nexus, and Maven |

## Adding a New MCP

1. Create a new folder: `mcp/<mcp-name>/`
2. Initialize with `package.json`, `tsconfig.json`, and project structure
3. Register it in your tool's MCP configuration
4. Add it to the table above
