# ⚡ SpringBreaker

> Breaks through Spring Boot dependency vulnerabilities — deterministically.

A deterministic MCP server that automates remediation of Spring Boot Maven dependency vulnerabilities using IQ Server (Sonatype Lifecycle), Nexus Repository, and Maven.

## Overview

This MCP server owns all domain logic for vulnerability remediation. The AI only orchestrates high-level commands like "Resolve HIGH and MEDIUM vulnerabilities." The MCP will:

1. Inspect the project
2. Download IQ report
3. Build dependency graph
4. Create execution plan
5. Present plan for approval
6. Execute approved plan
7. Verify build
8. Rescan IQ
9. Replan if necessary
10. Produce summary

## Prerequisites

- **Node.js** >= 18.0.0
- **Maven** (or Maven Wrapper `./mvnw`)
- **Sonatype IQ Server** (optional but recommended)
- **Sonatype Nexus Repository** (optional but recommended)
- **Git** (for version control)

## Installation

```bash
cd mcp/springbreaker
npm install
npm run build
```

## Configuration

### Environment Variables

Create a `.env` file in the project root or in your target Maven project:

```bash
# Sonatype IQ Server Configuration
IQ_SERVER_URL=http://localhost:8070
IQ_SERVER_TOKEN=your-iq-server-token-here
IQ_APP_ID=your-application-id

# Sonatype Nexus Repository Configuration
NEXUS_URL=http://localhost:8081
NEXUS_USERNAME=admin
NEXUS_PASSWORD=admin123

# Maven Configuration
PREFER_MVNW=true
MAVEN_OPTS=-Xmx2g

# Policy Defaults
DEFAULT_SEVERITY=HIGH,MEDIUM
ALLOW_MINOR_UPGRADES=true
ALLOW_MAJOR_UPGRADES=false
ALLOW_SNAPSHOTS=false
ALLOW_REDHAT=false

# Logging
LOG_LEVEL=info
```

### Policy Configuration

Create a `.remediation-policy.json` file in your Maven project root to customize remediation behavior:

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
  "verifyIq": true
}
```

## Usage

### Running the MCP Server

```bash
# Development mode (with watch)
npm run dev

# Production mode
npm run start
```

### MCP Tools

The server exposes 5 tools:

#### 1. inspect_project

Inspect a Maven project and gather information about its structure, dependencies, and capabilities.

```json
{
  "projectPath": "/path/to/your/maven/project"
}
```

#### 2. build_plan

Build an execution plan for remediating vulnerabilities.

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

#### 3. execute_plan

Execute an approved remediation plan.

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

#### 4. verify

Verify the build and run IQ scan.

```json
{
  "projectPath": "/path/to/your/maven/project"
}
```

#### 5. summarize

Generate a summary of the remediation results.

```json
{
  "projectPath": "/path/to/your/maven/project",
  "executionId": "execution-id-from-execute-plan"
}
```

## Integration with OpenCode

### Option 1: Global Configuration

Add to your OpenCode MCP configuration:

```json
{
  "mcpServers": {
    "springbreaker": {
      "command": "node",
      "args": ["/path/to/mcp/springbreaker/dist/index.js"],
      "env": {
        "IQ_SERVER_URL": "http://your-iq-server:8070",
        "IQ_SERVER_TOKEN": "your-token",
        "IQ_APP_ID": "your-app-id",
        "NEXUS_URL": "http://your-nexus:8081",
        "NEXUS_USERNAME": "admin",
        "NEXUS_PASSWORD": "admin123"
      }
    }
  }
}
```

### Option 2: VS Code Configuration

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

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Server (stdio)                        │
├─────────────────────────────────────────────────────────────┤
│  Tools (Public API)                                         │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐          │
│  │ inspect_    │ │ build_plan  │ │ execute_    │          │
│  │ project     │ │             │ │ plan        │          │
│  └─────────────┘ └─────────────┘ └─────────────┘          │
│  ┌─────────────┐ ┌─────────────┐                           │
│  │ verify      │ │ summarize   │                           │
│  └─────────────┘ └─────────────┘                           │
├─────────────────────────────────────────────────────────────┤
│  Internal Services (Hidden from MCP)                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ IQ       │ │ Nexus    │ │ Maven    │ │ Git      │      │
│  │ Worker   │ │ Worker   │ │ Worker   │ │ Worker   │      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                   │
│  │ POM      │ │ Policy   │ │ Planner  │                   │
│  │ Worker   │ │ Engine   │ │ (DAG)    │                   │
│  └──────────┘ └──────────┘ └──────────┘                   │
├─────────────────────────────────────────────────────────────┤
│  Utilities                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ Lock     │ │ SemVer   │ │ Retry    │ │ Hash     │      │
│  │ (mutex)  │ │ (parse)  │ │ (backoff)│ │ (SHA-256)│      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
│  ┌──────────┐ ┌──────────┐                                 │
│  │ Concur.  │ │ Logger   │                                 │
│  │ (p-limit)│ │ (struct) │                                 │
│  └──────────┘ └──────────┘                                 │
└─────────────────────────────────────────────────────────────┘
```

## Design Principles

- **Deterministic over heuristic** - No LLM reasoning for dependency decisions
- **Safe upgrades** - Prefer patch > minor > major upgrades
- **Parallel execution** - Independent tasks run in parallel
- **Verifiable** - Every change can be verified and rolled back
- **Policy-driven** - All decisions follow encoded business rules

## Remediation Priority

The MCP follows this priority order:

1. Upgrade Spring Boot parent/BOM patch
2. Upgrade owning direct dependency
3. Upgrade direct dependency itself
4. Apply IQ suggested version
5. Search Nexus for latest stable GA version
6. Override vulnerable transitive dependency
7. Exclude and replace
8. Remove dependency if unused

## Testing

~275 tests across 19 test files covering engine logic, utilities, workers, and tool handlers.

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Test structure

```
test/
├── config.test.ts              # Env + policy config loading
├── store.test.ts               # In-memory plan store (LRU)
├── engine/
│   ├── dependency-graph.test.ts  # Maven tree parsing, ownership
│   ├── planner.test.ts           # Golden plan tests, DAG invariants
│   └── policy-engine.test.ts     # Severity filtering, priority logic
├── failure-injection.test.ts     # Spec §45: IQ/Nexus/Maven/POM failure scenarios
├── tools/
│   ├── concurrency.test.ts       # Bounded concurrency limiters
│   ├── errors.test.ts            # Error classes + handleToolError
│   ├── hash.test.ts              # SHA-256 fingerprinting
│   ├── lock.test.ts              # Project-level mutex
│   ├── logger.test.ts            # Structured logging + withContext
│   ├── retry.test.ts             # Exponential backoff
│   └── semver.test.ts            # Version parsing + comparison
├── tools/
│   └── tool-handler.test.ts    # Integration: full pipeline (mocked I/O)
└── workers/
    ├── git-worker.test.ts        # Git operations (mocked simple-git)
    ├── iq-worker.test.ts         # IQ API (mocked fetch)
    ├── maven-worker.test.ts      # Maven spawn (mocked child_process)
    ├── nexus-worker.test.ts      # Nexus API (mocked fetch)
    └── pom-worker.test.ts        # POM XML read/write/modify
```

## Development

```bash
# Type check
npm run typecheck

# Lint
npm run lint

# Lint with auto-fix
npm run lint:fix

# Clean build
npm run clean
npm run build
```

## License

MIT
