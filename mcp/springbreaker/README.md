# SpringBreaker

SpringBreaker is a deterministic, local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for planning, applying, and verifying Maven dependency remediations in Spring Boot projects. Sonatype IQ supplies vulnerability findings and recommended versions; Nexus Repository and Maven Central supply version candidates. Dependency decisions are made by encoded policy, not by an LLM.

The server uses stdio, makes POM edits only after explicit approval, verifies each batch, and restores the current batch if verification fails.

## Requirements

- Node.js 20 or newer
- Maven 3.8+ or a checked-in executable Maven Wrapper
- A compatible JDK for the target project
- Sonatype IQ Server credentials and an application public ID for vulnerability planning
- Optional Sonatype Nexus Repository credentials for private version discovery

Without IQ, `inspect_project` and Maven analysis still work, but `build_plan` has no vulnerability findings and returns an empty plan with a warning. Without Nexus, public component lookup falls back to Maven Central.

## Install and verify

From this directory:

```bash
npm ci
npm run check
npm start
```

`npm run check` runs strict type checking, zero-warning lint, the test suite with enforced coverage, and a production build. The server writes protocol messages to stdout and operational logs to stderr.

## Trusted server configuration

Set service credentials in the MCP process environment or in `.env` beside this package. Do not commit `.env`. Copy `.env.example` for the complete list.

```dotenv
IQ_SERVER_URL=https://iq.example.com
IQ_USERNAME=service-account
IQ_SERVER_TOKEN=replace-with-secret
IQ_APP_ID=my-public-application-id

NEXUS_URL=https://nexus.example.com
NEXUS_USERNAME=read-only-account
NEXUS_PASSWORD=replace-with-secret

SPRINGBREAKER_ALLOWED_ROOTS=/srv/workspaces:/opt/projects
PREFER_MVNW=true
LOG_LEVEL=info
```

Non-loopback service URLs must use HTTPS. For an intentionally insecure non-loopback development service, set `ALLOW_INSECURE_HTTP=true` only in trusted server configuration.

Target-project `.env` files can supply project policy values such as `DEFAULT_SEVERITY`, but cannot override IQ/Nexus credentials by default. `ALLOW_PROJECT_SERVICE_CONFIG=true` opts into that weaker trust model, and only complete IQ or Nexus credential bundles are accepted from a project. `MAVEN_OPTS`, `MAVEN_ENV_ALLOWLIST`, allowed roots, and trust switches always come from trusted server configuration.

`SPRINGBREAKER_ALLOWED_ROOTS` is strongly recommended for shared hosts. Separate multiple roots with the platform path delimiter (`:` on Unix, `;` on Windows). Paths and module POMs are canonicalized to prevent symlink escape and lock bypass.

### Maven subprocess environment

Maven receives a small operating-system/JDK allowlist rather than the complete server environment, so IQ and Nexus secrets are not inherited. Secret credential names are rejected even if listed. Add only required non-secret variable names:

```dotenv
MAVEN_ENV_ALLOWLIST=HTTP_PROXY,HTTPS_PROXY,NO_PROXY
```

Because Maven wrappers, plugins, and tests are project-controlled code, run SpringBreaker with a least-privilege account or inside an appropriately restricted container.

## Project policy

Place `.remediation-policy.json` in the target Maven project when its defaults need adjustment:

```json
{
  "severity": ["CRITICAL", "HIGH", "MEDIUM"],
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

Unknown or invalid policy values fail closed. Unused-dependency removal is proposed only when the pinned Maven dependency analysis identifies that exact declaration; failed or ambiguous analysis remains “unknown” and causes no removal.

## MCP client configuration

Build first, then configure any stdio-capable MCP client with an absolute path:

```json
{
  "mcpServers": {
    "springbreaker": {
      "command": "node",
      "args": ["/absolute/path/to/daemon/mcp/springbreaker/dist/index.js"],
      "env": {
        "IQ_SERVER_URL": "https://iq.example.com",
        "IQ_USERNAME": "service-account",
        "IQ_SERVER_TOKEN": "${IQ_SERVER_TOKEN}",
        "IQ_APP_ID": "my-public-application-id",
        "SPRINGBREAKER_ALLOWED_ROOTS": "/absolute/path/to/projects"
      }
    }
  }
}
```

Use the client’s secret facility when available. Never place a real token in a committed client configuration.

## Safe workflow

1. Call `inspect_project` to validate the path and see detected capabilities.
2. Call `build_plan`; it resolves the dependency graph, uploads a CycloneDX SBOM to IQ, applies policy, and stores an immutable plan.
3. Review every task, risk, evidence item, expected fix, and planning issue.
4. Call `execute_plan` with `approveAll: true` or a non-empty `approvedTasks` list. Use `dryRun: true` to preview without consuming the plan.
5. Call `verify` for an independent build/IQ check and `summarize` for the stored audit result.

Every response has structured content shaped as `{ "ok": true, "data": ... }` or `{ "ok": false, "error": ... }`. Errors include a stable code and recoverability flag. Long operations report MCP progress and honor cancellation.

### `inspect_project`

Read-only project structure and capability inspection. It does not run project build plugins.

```json
{ "projectPath": "/absolute/path/to/project" }
```

### `build_plan`

Build and persist a project-bound plan. A plan records the canonical project path, full project fingerprint, policy hash, Git revision, and a non-secret binding to its IQ/Nexus endpoints and IQ application.

```json
{
  "projectPath": "/absolute/path/to/project",
  "severity": ["CRITICAL", "HIGH"],
  "policy": {
    "allowMinor": true,
    "allowMajor": false,
    "verifyBuild": true,
    "verifyIq": true
  }
}
```

### `execute_plan`

Execute explicitly approved tasks. `commit` and `createBranch` default to `false`.

```json
{
  "projectPath": "/absolute/path/to/project",
  "planId": "00000000-0000-4000-8000-000000000000",
  "approvedTasks": ["00000000-0000-4000-8000-000000000001"],
  "dryRun": false,
  "commit": false,
  "createBranch": false
}
```

Use either `approvedTasks` or `approveAll`, never both. A non-dry execution claims the plan for one-shot use so duplicated requests cannot repeat edits. If project content, policy, or path differs from the plan, execution is rejected as stale.

Before editing, all project POMs are backed up outside the project. Tasks run in dependency-ordered batches. Each batch is verified as a unit; a failed batch restores only its own changes, preserving earlier successful batches. IQ verification compares exact coordinates and versions, not vulnerability IDs alone. Git branch creation and commits require explicit flags, a Git repository, and a clean working tree; commits stage only POMs changed by SpringBreaker.

After a successful batch, IQ results can trigger deterministic replanning. Actions identical to those already approved may continue. A new target, priority, component, or POM target pauses execution and returns `continuationPlanId`; review and explicitly approve that new immutable plan before continuing.

### `verify`

Run a fresh `mvn clean verify` and IQ scan, with optional comparison to a stored execution:

```json
{
  "projectPath": "/absolute/path/to/project",
  "skipBuild": false,
  "skipIq": false,
  "compareWithExecutionId": "00000000-0000-4000-8000-000000000002"
}
```

### `summarize`

Return a project-bound summary of a stored execution:

```json
{
  "projectPath": "/absolute/path/to/project",
  "executionId": "00000000-0000-4000-8000-000000000002"
}
```

## Deterministic decision order

SpringBreaker prefers coordinated Spring Boot parent/property/BOM updates, then owning or direct dependencies, repository-confirmed stable upgrades, conservative transitive overrides, and exact unused declarations. Patch upgrades are preferred over minor and major upgrades. Snapshots, vendor builds, and disallowed version ranges are filtered by policy.

IQ remediation data is interpreted using Sonatype’s application, third-party scan, report, and component-remediation API contracts. Nexus search and Maven Central `gav` search are paginated and bounded. Maven, IQ, Nexus, and Maven Central calls use bounded concurrency, retry only eligible failures, and cap response/output sizes.

## Runtime state and limits

Plans and executions are held in memory by one server process:

- up to 50 plans, retained for 24 hours with LRU-style refresh;
- up to 100 execution records, retained for seven days;
- state is lost on process restart;
- `execute_plan` and `summarize` must use the same running MCP process that created their IDs.

Re-run `build_plan` after a restart, an expired plan, a stale fingerprint, or a completed non-dry execution. This state model is appropriate for a local stdio server; durable or horizontally scaled transports require an external implementation of the plan store plus transport authentication and authorization.

## Operational notes

- `inspect_project`, `build_plan`, `execute_plan`, and `verify` are serialized per canonical project path.
- Maven workflows default to five-minute timeouts and HTTP attempts to 15 seconds; policy can set workflow timeouts up to one hour through tool input.
- Maven output and HTTP bodies are bounded to prevent unbounded memory growth.
- Maven Central is a public fallback only; private components need Nexus or an IQ recommendation that the project build can resolve.
- SpringBreaker supports stdio only. Do not expose it as a network service without adding transport authentication, authorization, rate limiting, and durable shared state.
- Sonatype deployments vary by version. Validate the configured API endpoints against the IQ version used in production before rollout.

## Troubleshooting

**Plan not found or already claimed** — Plans expire, disappear on restart, and are single-use for non-dry execution. Build and review a new plan.

**Plan is stale** — A POM, module layout, wrapper configuration, policy, canonical path, or Git revision changed after planning. Build a new plan rather than bypassing the check.

**Empty plan** — Confirm both `IQ_SERVER_TOKEN` and `IQ_APP_ID` are present and that the application/report contains findings at the selected severities.

**HTTP URL rejected** — Use HTTPS. Plain HTTP is accepted automatically only for loopback hosts; the trusted `ALLOW_INSECURE_HTTP=true` escape hatch is intended for controlled development networks.

**Maven wrapper ignored** — On Unix, the checked-in wrapper must already be executable. SpringBreaker never changes its permissions. Otherwise it safely falls back to `mvn` on `PATH`.

**Build or scan times out** — Increase policy `timeout` deliberately, inspect stderr structured logs, and confirm the target build and Sonatype services are healthy.

## Development and release gates

```bash
npm ci --ignore-scripts
npm run check
npm audit --audit-level=moderate
npm pack --dry-run
```

CI runs these gates on Node.js 20 and 22. Coverage thresholds are enforced in `vitest.config.ts`; dependency updates are managed by Dependabot. See the [design document](docs/SpringBoot-IQ-Nexus-MCP-Design.md), [MCP overview](../README.md), [contribution guide](../../CONTRIBUTING.md), [security policy](SECURITY.md), and [changelog](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).
