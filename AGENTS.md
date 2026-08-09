# AGENTS.md

Guidance for AI coding agents (and human contributors) working in this repository.

> **This repository is public on GitHub.** Treat every file as visible to the world:
> never commit real credentials, tokens, or internal URLs. Use the placeholders from
> `.env.example` only. See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution rules.

## What this repo is

A **deterministic** Model Context Protocol (MCP) server that automates remediation of
Spring Boot Maven dependency vulnerabilities using **Sonatype IQ Server** (Lifecycle),
**Sonatype Nexus Repository**, and **Maven**. "Deterministic" means no LLM reasoning is
used for dependency decisions — all remediation choices follow encoded business rules.

The actual server code lives in **`mcp/springbreaker/`**. The `mcp/` folder is designed to
hold multiple isolated MCP servers, each with its own dependencies and build.

### Read these first (link, don't duplicate)

- **Design doc** — [`SpringBoot-IQ-Nexus-MCP-Design.md`](./SpringBoot-IQ-Nexus-MCP-Design.md)
  (authoritative architecture & requirements)
- **MCP overview** — [`mcp/README.md`](./mcp/README.md)
- **Server README** — [`mcp/springbreaker/README.md`](./mcp/springbreaker/README.md)
  (setup, config, tool usage, OpenCode/VS Code integration)

Do **not** copy documentation that already exists in these files into this one — link to it.

## Working directory

All build/test/lint commands run from the server package:

```bash
cd mcp/springbreaker
```

## Commands

| Task          | Command                          | Notes                               |
| ------------- | -------------------------------- | ----------------------------------- |
| Install deps  | `npm install`                    |                                     |
| Type check    | `npm run typecheck`              | `tsc --noEmit`                      |
| Run tests     | `npm test`                       | `vitest run` — ~275 tests, all pass |
| Test watch    | `npm run test:watch`             |                                     |
| Test coverage | `npm run test:coverage`          |                                     |
| Lint          | `npm run lint`                   | `eslint src/ test/`                 |
| Lint + fix    | `npm run lint:fix`               |                                     |
| Build         | `npm run build`                  | `tsc` → `dist/`                     |
| Clean build   | `npm run clean && npm run build` |                                     |
| Dev (watch)   | `npm run dev`                    | `tsx watch src/index.ts`            |
| Run server    | `npm start`                      | `node dist/index.js`                |

**Always run typecheck + tests + lint before considering a change complete.**

## Language & module system (critical)

- Package is **ESM**: `"type": "module"` with `module`/`moduleResolution: Node16`.
- Use `import` — **never** `require`.
- All relative imports **must include the explicit `.js` extension** even though the source
  is `.ts`:
  ```ts
  import { logger } from "../utils/logger.js"; // correct
  import { logger } from "../utils/logger"; // wrong — breaks Node16 ESM
  ```
- `tsconfig.json` is strict: `strict: true`, `noUnusedLocals`, `noUnusedParameters`,
  `noImplicitReturns`, `noFallthroughCasesInSwitch`. Keep it clean.

## Architecture map

```
mcp/springbreaker/src/
├── index.ts            # MCP server entry (stdio). McpServer + server.tool()
├── config.ts           # Env + policy config (dotenv.parse, readEnvFile/resolveEnv)
├── store.ts            # MemPlanStore (in-memory, LRU eviction) + planStore singleton
├── types/index.ts      # All shared types (RemediationTask, ExecutionPlan, PolicyConfig…)
├── engine/             # Pure domain logic (no I/O)
│   ├── dependency-graph.ts   # Parses `mvn dependency:tree` → DependencyGraph
│   ├── policy-engine.ts      # Severity filtering, IQ suggestion evaluation
│   └── planner.ts            # Builds DAG of RemediationTask in dependency-ordered batches
├── tools/              # The 5 public MCP tools (barrel index.ts)
│   ├── schemas.ts            # Zod input schemas (all tool inputs)
│   ├── project-info.ts       # buildProjectInfo() shared by inspect_project & build_plan
│   ├── inspect-project.ts
│   ├── build-plan.ts
│   ├── execute-plan.ts
│   ├── verify.ts
│   └── summarize.ts
├── workers/            # Stateless I/O workers (fresh instance per call)
│   ├── pom-worker.ts         # All pom.xml read/write (fast-xml-parser) — HIGH RISK
│   ├── maven-worker.ts       # spawn() Maven, dependency:tree, clean verify
│   ├── git-worker.ts         # simple-git branch/commit/restore
│   ├── iq-worker.ts          # Sonatype IQ REST API
│   └── nexus-worker.ts       # Nexus search for latest stable GA version
└── utils/
    ├── concurrency.ts         # Bounded p-limit for Nexus/IQ/Maven (spec §18)
    ├── errors.ts              # MCPError base + POMError/IQServerError/NexusError…
    ├── hash.ts                # SHA-256 fingerprinting for plan validation
    ├── lock.ts                # withProjectLock() project-level mutex
    ├── logger.ts              # createChildLogger() with structured context → stderr
    ├── retry.ts               # withRetry() exponential backoff + jitter
    ├── semver.ts              # parseVersion, compareVersions, isUpgradeAllowed…
    └── index.ts
```

### The 5 MCP tools

| Tool              | File                 | Purpose                                                         |
| ----------------- | -------------------- | --------------------------------------------------------------- |
| `inspect_project` | `inspect-project.ts` | Inspect a Maven project's structure/deps/capabilities           |
| `build_plan`      | `build-plan.ts`      | Fetch dep tree + IQ report, apply policy, build & persist plan  |
| `execute_plan`    | `execute-plan.ts`    | Execute approved plan in batches w/ per-batch verify + rollback |
| `verify`          | `verify.ts`          | `mvn clean verify` + optional IQ scan                           |
| `summarize`       | `summarize.ts`       | Summary from stored execution (read-only)                       |

### Server setup pattern (`src/index.ts`)

- `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`; `StdioServerTransport` from
  `@modelcontextprotocol/sdk/server/stdio.js`.
- Register tools via `server.tool(tool.name, tool.description, tool.inputSchema.shape, handler)`.
- Each handler validates args with `tool.inputSchema.safeParse(args)` and returns an
  `isError: true` response (with `VALIDATION_ERROR`) on failure — never throw raw errors.
- Graceful shutdown via `SIGTERM`/`SIGINT` → `server.close()`.

## ⚠️ Critical pitfalls (read before editing)

These are hard-won, codebase-specific traps. Violating them silently corrupts data or
breaks the server.

1. **`pom-worker.ts` — `parseTagValue: false` is sacred.** With `true`, `fast-xml-parser`
   coerces numeric-looking text to JS numbers, so `<version>2.0.0</version>` → `2` →
   re-serializes as `<version>2</version>`, **silently corrupting POMs on every write**.
   Never revert this. Also force arrays via `isArray` for `dependency`, `plugin`, `profile`,
   `module`, `exclusion`, `property`.

2. **`withProjectLock()` for anything touching project files.** Wrap `inspect_project`,
   `build_plan`, `execute_plan`, and `verify` handlers in `withProjectLock(projectPath, …)`
   (from `src/utils/lock.ts`). `summarize` is the exception (read-only store lookup).
   Never mutate project files outside the lock. When implementing the lock, store
   `cleanup = next.then(...)` in a variable and compare against it in `finally` — calling
   `next.then()` twice creates distinct promises and leaks the map entry.

3. **Never `dotenv.config()` in this long-running server.** It mutates `process.env` and
   causes cross-project contamination. Use `dotenv.parse()` on file content via the
   `readEnvFile()` + `resolveEnv()` helpers in `src/config.ts` (file env wins, then
   `process.env`).

4. **Back up ALL POMs before modifying.** Use `pomWorker.findPomFiles()` to discover root
   **and** module POMs in multi-module projects — backing up only the root leaves module
   POMs unprotected.

5. **Batch rollback restores only the current batch's POMs.** Restore from `batchChanges`
   (the POMs touched in the current batch), not all backups — restoring everything reverts
   earlier successful batches.

6. **Never mutate input arrays.** Copy first, e.g. `[...vuln.fixVersions].sort(...)` —
   `Array.sort()` mutates in place and permanently reorders shared objects.

7. **Never reuse plan IDs on replan.** Generate a new `randomUUID()` and set
   `previousPlanId` for lineage. Reusing the old ID leaves `ExecutionState` referencing
   stale plan data.

8. **`updateDependencyVersion` must handle `${x.version}` property references** (update the
   property, not the literal) **and `dependencyManagement` entries**, not just
   `project.dependencies`.

9. **`MavenWorker` uses `spawn()`, never `exec()`** (shell injection). Prefer `./mvnw`
   wrapper when `preferMvnw` is set.

10. **Spring Boot priority rule:** `determinePriority` must **not** return
    `upgrade-spring-boot-parent` for individual managed components (that would set the
    parent version to a component's own version). Managed components are skipped in
    `createTasksForComponent`; only the single dedicated boot task uses that priority.

11. **Build verification is per-batch, not per-task** (design-doc requirement).

12. **Multi-module targeting:** `executeRemediationTask` uses `task.pomPath ?? rootPomPath`
    so module POMs can be targeted.

13. **Workers are stateless.** Fresh instances per call (e.g. `GitWorker` creates a new
    `SimpleGit` per method). Mutable instance state causes race conditions in an MCP server.

14. **Error handling:** use `handleToolError(error)` (returns `isError: true`) rather than
    throwing. Custom error classes live in `src/utils/errors.ts` (`MCPError` base +
    `POMError`, `IQServerError`, `NexusError`, `MavenError`, `GitError`), each with `code`
    and `recoverable` flags.

15. **Logging goes to stderr only** via `createChildLogger(context)` from
    `src/utils/logger.ts`. **Never log to stdout** — stdout carries the JSON-RPC protocol.

16. **Structured logging with `withContext()`.** The child logger supports attaching
    structured context (`executionId`, `planId`, `taskId`, `project`) via
    `log.withContext({ executionId, planId })`. Use this in tool handlers to ensure all
    log messages carry traceable identifiers (spec §41).

17. **`execute_plan` commit/branch are opt-in.** The `commit` and `createBranch` flags
    default to `false`. Never auto-commit or auto-branch without the caller's explicit
    request (spec §5).

## Configuration

- **Env vars** (see `.env.example` and `src/config.ts`): `IQ_SERVER_URL`, `IQ_SERVER_TOKEN`,
  `IQ_APP_ID`, `IQ_USERNAME`, `NEXUS_URL`, `NEXUS_USERNAME`, `NEXUS_PASSWORD`,
  `PREFER_MVNW`, `MAVEN_OPTS`, `DEFAULT_SEVERITY`, `ALLOW_MINOR_UPGRADES`,
  `ALLOW_MAJOR_UPGRADES`, `ALLOW_SNAPSHOTS`, `ALLOW_REDHAT`, `LOG_LEVEL`.
  `.env` may live at the server root **or** in the target Maven project.
- **Policy** can also be set via `.remediation-policy.json` in the Maven project root
  (severity, preferParentUpgrade, allowPatch/Minor/Major, verifyBuild, verifyIq, …).
- `validateEnvConfig()` enforces `IQ_SERVER_TOKEN`, `IQ_APP_ID`, `NEXUS_USERNAME`.

## Testing

- **Framework:** Vitest 3 (`vitest.config.ts`: `globals: true`, `environment: 'node'`,
  `include: ['test/**/*.test.ts']`).
- **Location:** 19 test files, ~275 tests across `test/engine/`, `test/utils/`,
  `test/workers/`, and `test/tools/`:
  - `engine/` — `dependency-graph.test.ts`, `planner.test.ts` (includes golden plan and
    DAG invariant tests), `policy-engine.test.ts`
  - `utils/` — `semver.test.ts`, `lock.test.ts`, `hash.test.ts`, `retry.test.ts`,
    `concurrency.test.ts`, `errors.test.ts`, `logger.test.ts`
  - `workers/` — `pom-worker.test.ts`, `git-worker.test.ts`, `nexus-worker.test.ts`,
    `iq-worker.test.ts`, `maven-worker.test.ts`
  - `tools/` — `tool-handler.test.ts` (integration tests for full pipeline)
  - Root — `config.test.ts`, `store.test.ts`, `failure-injection.test.ts`
- **Worker tests** mock I/O (fetch, simple-git, child_process) to test logic without
  external services. For workers with retry logic, mock the private `request` method
  to avoid timeout from exponential backoff.
- **Integration tests** cover the full `build_plan` → `execute_plan` → `verify` →
  `summarize` pipeline with all external I/O mocked.
- **Failure injection tests** cover spec §45 scenarios: IQ 401/500, Nexus 404/500,
  Maven build failure, malformed POM, no-fix-available, policy-blocked upgrades.

## Contribution rules

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full checklist (tests, POM safety,
verification, license). Key points: run typecheck + tests + lint; never commit secrets;
back up POMs; verify builds per batch.
