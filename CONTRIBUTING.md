# Contributing to SpringBreaker

Thanks for contributing! This repository is **public on GitHub**, so please keep everything
you commit appropriate for public view — **never commit real credentials, tokens, or
internal URLs**.

## Getting started

```bash
cd mcp/springbreaker
npm install
npm run typecheck
npm test
npm run lint
```

## Before you submit

Run the full verification workflow (typecheck + tests + lint). See the
[`run-tests-lint` skill](.github/skills/run-tests-lint/SKILL.md) for details.

- [ ] `npm run typecheck` passes (strict TS — no unused vars/params)
- [ ] `npm test` passes (~275 tests)
- [ ] `npm run lint` passes
- [ ] `npm run build` succeeds (confirms ESM/Node16 resolution)
- [ ] No secrets or internal URLs committed

## Code conventions

- **ESM only** — `import`, never `require`; relative imports use the `.js` suffix.
- **Stateless workers** — worker classes must not hold mutable instance state (race
  conditions in an MCP server). Create fresh instances per call.
- **Error handling** — use `handleToolError()` and the custom error classes in
  `src/utils/errors.ts`; don't throw raw errors from tool handlers.
- **Logging** — via `createChildLogger()` to **stderr only** (stdout carries JSON-RPC).
- **Strict TS** — keep `tsconfig.json` strict settings satisfied.

## POM-safety rules (critical)

These prevent silent corruption of `pom.xml` files:

1. **Never change `parseTagValue: false`** in `pom-worker.ts` — it prevents
   `fast-xml-parser` from coercing `<version>2.0.0</version>` into `2`.
2. **Back up ALL POMs** (root + modules via `findPomFiles()`) before modifying.
3. **Batch rollback restores only the current batch's POMs** (from `batchChanges`).
4. **Never mutate input arrays** — copy first (`[...arr].sort(...)`).
5. **Never reuse plan IDs on replan** — new `randomUUID()` + `previousPlanId`.
6. **`updateDependencyVersion`** must handle `${x.version}` property refs and
   `dependencyManagement`, not just `project.dependencies`.

See [`AGENTS.md`](./AGENTS.md) for the full list of pitfalls.

## Testing

- Framework: **Vitest 3** (`globals: true`, `environment: 'node'`).
- Tests live in `test/engine/`, `test/utils/`, `test/workers/`, and `test/tools/` covering
  the dependency graph, planner, policy engine, semver utils, all workers, and tool handlers.
- Add tests alongside any behavior change; don't weaken assertions to make tests pass.

## Architecture

The server is a deterministic MCP server (no LLM reasoning for dependency decisions).
Read the [design doc](./SpringBoot-IQ-Nexus-MCP-Design.md) and
[`mcp/springbreaker/README.md`](./mcp/springbreaker/README.md) before making architectural
changes. The 5 public tools are `inspect_project`, `build_plan`, `execute_plan`, `verify`,
and `summarize`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./mcp/springbreaker/README.md#license) (as declared in the server README).
