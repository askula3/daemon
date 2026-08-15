# ⚡ SpringBreaker

> Breaks through Spring Boot dependency vulnerabilities — deterministically.

A deterministic [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that automates remediation of Spring Boot Maven dependency vulnerabilities. No LLM reasoning is used for dependency decisions — all remediation choices follow encoded business rules.

**Works with or without Sonatype IQ Server and Nexus Repository.** When IQ/Nexus are not configured, the server falls back to Maven Central for version resolution.

## Quick Start (2 minutes)

### Prerequisites

- **Node.js** >= 18.0.0
- **Maven** or Maven Wrapper (`./mvnw`) on PATH
- A Spring Boot Maven project

### Install and build

```bash
cd mcp/springbreaker
npm install
npm run build
```

### Test it works

```bash
# Verify the server starts (Ctrl+C to stop)
node dist/index.js
```

### No IQ Server? No Nexus? No problem.

The server works without any external services. Without IQ Server it cannot detect vulnerabilities automatically, but it can still inspect your project, analyse the dependency tree, and suggest upgrades from Maven Central.

To enable full vulnerability scanning, configure IQ Server (see [Full Setup](#full-setup-with-iq-server--nexus)).

## Full Setup (with IQ Server + Nexus)

### Environment variables

Create a `.env` file in your Maven project root or in the server directory:

```bash
# ── IQ Server (optional — enables vulnerability scanning) ────────
IQ_SERVER_URL=http://localhost:8070
IQ_SERVER_TOKEN=your-iq-server-token-here
IQ_APP_ID=your-application-id

# ── Nexus Repository (optional — enables private repo lookups) ──
# When not configured, the server uses Maven Central (search.maven.org)
NEXUS_URL=http://localhost:8081
NEXUS_USERNAME=admin
NEXUS_PASSWORD=admin123

# ── Maven ────────────────────────────────────────────────────────
PREFER_MVNW=true
# MAVEN_OPTS=-Xmx2g

# ── Policy defaults ──────────────────────────────────────────────
DEFAULT_SEVERITY=HIGH,MEDIUM
ALLOW_MINOR_UPGRADES=true
ALLOW_MAJOR_UPGRADES=false
ALLOW_SNAPSHOTS=false
ALLOW_REDHAT=false

# ── Logging (debug | info | warn | error) ────────────────────────
LOG_LEVEL=info
```

### Policy configuration

Create `.remediation-policy.json` in your Maven project root to customise remediation behaviour:

```json
{
  "severity": ["HIGH", "MEDIUM"],
  "preferParentUpgrade": true,
  "preferOwningDependency": true,
  "preferIqSuggestion": true,
  "removeUnused": true,
  "allowPatch": true,
  "allowMinor": true,
  "allowMajor": false,
  "allowSnapshots": false,
  "allowRedhat": false,
  "verifyBuild": true,
  "verifyIq": true,
  "maxBatchSize": 10,
  "timeout": 300000,
  "maxReplans": 3,
  "maxBatches": 10,
  "maxMavenFailures": 3,
  "maxModifications": 50
}
```

### Capability matrix

| Feature                  |  IQ + Nexus   |  IQ only   |        Nexus only        |     Neither      |
| ------------------------ | :-----------: | :--------: | :----------------------: | :--------------: |
| Inspect project          |      ✅       |     ✅     |            ✅            |        ✅        |
| Dependency tree analysis |      ✅       |     ✅     |            ✅            |        ✅        |
| Vulnerability detection  |  ✅ IQ scan   | ✅ IQ scan |            ❌            |        ❌        |
| Version resolution       | ✅ IQ → Nexus | ✅ IQ only | ✅ Nexus → Maven Central | ✅ Maven Central |
| Build verification       |      ✅       |     ✅     |            ✅            |        ✅        |
| Auto-commit/branch       |      ✅       |     ✅     |            ✅            |        ✅        |

## Integration

### VS Code

Create `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "springbreaker": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/mcp/springbreaker/dist/index.js"],
      "env": {
        "IQ_SERVER_URL": "${env:IQ_SERVER_URL}",
        "IQ_SERVER_TOKEN": "${env:IQ_SERVER_TOKEN}",
        "IQ_APP_ID": "${env:IQ_APP_ID}"
      }
    }
  }
}
```

For sensitive values, use input variables instead of environment references:

```json
{
  "servers": {
    "springbreaker": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/mcp/springbreaker/dist/index.js"],
      "env": {
        "IQ_SERVER_TOKEN": "${input:iqToken}",
        "IQ_APP_ID": "${input:iqAppId}"
      }
    }
  },
  "inputs": [
    {
      "id": "iqToken",
      "type": "promptString",
      "description": "Sonatype IQ Server Token",
      "password": true
    },
    {
      "id": "iqAppId",
      "type": "promptString",
      "description": "IQ Application ID"
    }
  ]
}
```

### OpenCode / Crush

Add to `opencode.json` in your project root:

```json
{
  "mcp": {
    "springbreaker": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp/springbreaker/dist/index.js"],
      "env": {
        "IQ_SERVER_URL": "{env:IQ_SERVER_URL}",
        "IQ_SERVER_TOKEN": "{env:IQ_SERVER_TOKEN}",
        "IQ_APP_ID": "{env:IQ_APP_ID}"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "springbreaker": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/springbreaker/dist/index.js"]
    }
  }
}
```

### Generic MCP Client (stdio)

```bash
# The server communicates over stdin/stdout (JSON-RPC)
node /path/to/mcp/springbreaker/dist/index.js
```

Environment variables can be passed inline:

```bash
IQ_SERVER_TOKEN=xyz IQ_APP_ID=my-app node dist/index.js
```

## Tools Reference

### `inspect_project`

Inspect a Maven project's structure, dependencies, and capabilities. Returns recommendations when IQ/Nexus are not configured.

```json
{ "projectPath": "/path/to/your/maven/project" }
```

### `build_plan`

Build a remediation plan. Requires vulnerability data from IQ Server — without IQ, returns an empty plan with a warning.

```json
{
  "projectPath": "/path/to/your/maven/project",
  "severity": ["HIGH", "MEDIUM"],
  "policy": {
    "allowMinor": true,
    "allowMajor": false
  }
}
```

### `execute_plan`

Execute an approved remediation plan. Supports dry-run mode, optional auto-commit, and optional feature branch creation.

```json
{
  "projectPath": "/path/to/your/maven/project",
  "planId": "plan-id-from-build-plan",
  "approvedTasks": ["task-id-1", "task-id-2"],
  "dryRun": false,
  "commit": false,
  "createBranch": false
}
```

| Field           | Default | Description                                    |
| --------------- | ------- | ---------------------------------------------- |
| `approvedTasks` | all     | Task IDs to execute (empty = all)              |
| `dryRun`        | `false` | Preview changes without modifying files        |
| `commit`        | `false` | Auto-commit changes after successful execution |
| `createBranch`  | `false` | Create a feature branch before modifying files |

### `verify`

Run `mvn clean verify` and optionally re-scan with IQ Server.

```json
{
  "projectPath": "/path/to/your/maven/project",
  "skipBuild": false,
  "skipIq": false,
  "compareWithExecutionId": "optional-execution-id"
}
```

### `summarise`

Generate a summary of a completed remediation execution.

```json
{
  "projectPath": "/path/to/your/maven/project",
  "executionId": "execution-id-from-execute-plan"
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Server (stdio)                           │
├─────────────────────────────────────────────────────────────────┤
│  Tools (Public API)                                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐              │
│  │ inspect_    │ │ build_plan  │ │ execute_    │              │
│  │ project     │ │             │ │ plan        │              │
│  └─────────────┘ └─────────────┘ └─────────────┘              │
│  ┌─────────────┐ ┌─────────────┐                               │
│  │ verify      │ │ summarise   │                               │
│  └─────────────┘ └─────────────┘                               │
├─────────────────────────────────────────────────────────────────┤
│  Engine (Pure domain logic — no I/O)                           │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐           │
│  │ Dependency   │ │ Policy       │ │ Planner      │           │
│  │ GraphBuilder │ │ Engine       │ │ (DAG batches)│           │
│  └──────────────┘ └──────────────┘ └──────────────┘           │
├─────────────────────────────────────────────────────────────────┤
│  Workers (Stateless I/O — fresh instance per call)             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐         │
│  │ IQ       │ │ Nexus    │ │ Maven    │ │ Maven    │         │
│  │ Worker   │ │ Worker   │ │ Central  │ │ Worker   │         │
│  │          │ │          │ │ Worker   │ │          │         │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘         │
│  ┌──────────┐ ┌──────────┐                                    │
│  │ POM      │ │ Git      │                                    │
│  │ Worker   │ │ Worker   │                                    │
│  └──────────┘ └──────────┘                                    │
├─────────────────────────────────────────────────────────────────┤
│  Utilities                                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐         │
│  │ Lock     │ │ SemVer   │ │ Retry    │ │ Hash     │         │
│  │ (mutex)  │ │ (parse)  │ │ (backoff)│ │ (SHA-256)│         │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘         │
│  ┌──────────┐ ┌──────────┐                                    │
│  │ Concur.  │ │ Logger   │                                    │
│  │ (p-limit)│ │ (stderr) │                                    │
│  └──────────┘ └──────────┘                                    │
└─────────────────────────────────────────────────────────────────┘
```

### Version resolution fallback chain

```
IQ Server suggestion → Nexus Repository → Maven Central (public, no auth)
```

## Design Principles

- **Deterministic over heuristic** — No LLM reasoning for dependency decisions
- **Safe upgrades** — Prefer patch > minor > major upgrades
- **Parallel execution** — Independent tasks run in parallel (bounded concurrency)
- **Verifiable** — Every change can be verified and rolled back
- **Policy-driven** — All decisions follow encoded business rules
- **Works standalone** — No IQ or Nexus required for basic functionality

## Remediation Priority

1. Upgrade Spring Boot parent/BOM (coordinated upgrade)
2. Upgrade owning direct dependency
3. Upgrade direct dependency
4. Apply IQ suggested version
5. Search Nexus / Maven Central for latest stable GA version
6. Override vulnerable transitive dependency
7. Exclude and replace
8. Remove dependency if unused

## Testing

~250 tests across 19 test files covering engine logic, utilities, workers, and tool handlers.

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

## Troubleshooting

### "Plan not found" error when running `execute_plan`

Plans are stored in memory and lost when the server restarts. Run `build_plan` again in the same session.

### `build_plan` returns an empty plan

Without IQ Server configured, the server cannot detect vulnerabilities. Configure `IQ_SERVER_TOKEN` and `IQ_APP_ID` to enable vulnerability scanning.

### Maven command fails

- Ensure Maven (or `./mvnw`) is on PATH and the project builds with `mvn clean verify`
- Set `PREFER_MVNW=false` if you want to use the system `mvn` instead of the wrapper
- Check `MAVEN_OPTS` if builds fail with memory errors

### Server starts but tools aren't available in VS Code

- Check the MCP output log: Command Palette → MCP: List Servers → select SpringBreaker → Show Output
- Ensure the `dist/` directory exists (`npm run build`)
- Verify Node.js >= 18 (`node --version`)

### Nexus or IQ connection errors

- The server retries failed requests automatically (3 retries with exponential backoff)
- Check that the URLs are reachable from your machine
- Look for structured error codes in the response (`IQ_SERVER_ERROR`, `NEXUS_ERROR`)

## Development

```bash
cd mcp/springbreaker
npm install           # Install dependencies
npm run typecheck     # TypeScript strict check
npm test              # Run tests
npm run lint          # ESLint
npm run dev           # Watch mode (auto-restart on changes)
npm run build         # Production build → dist/
```

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](../../AGENTS.md) for the full architecture and critical pitfalls.

## License

MIT

## Overview

This MCP server owns all domain logic for vulnerability remediation. The AI only orchestrates high-level commands like "Resolve HIGH and MEDIUM vulnerabilities." The MCP will:
