# MCP Servers

This directory contains Model Context Protocol (MCP) servers built for Spring Boot and Java/Maven projects.

Each MCP is isolated in its own subfolder with independent dependencies, configuration, and build setup.

## Available MCPs

| MCP                                | Description                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [springbreaker/](./springbreaker/) | Deterministic Spring Boot Maven vulnerability remediation with IQ Server; Nexus is optional and Maven Central is the public fallback |

## Quick Start

```bash
# Build and run SpringBreaker
cd springbreaker
npm ci
npm run check
npm start
```

See [springbreaker/README.md](./springbreaker/README.md) for full setup, integration guides (VS Code, OpenCode, Claude Desktop), and tool reference.

## Adding a New MCP

1. Create a new folder: `mcp/<mcp-name>/`
2. Initialize with `package.json`, `tsconfig.json`, and project structure
3. Register it in your tool's MCP configuration
4. Add it to the table above
