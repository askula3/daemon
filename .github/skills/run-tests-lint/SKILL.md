---
name: run-tests-lint
description: 'Run the SpringBreaker MCP server test, typecheck, and lint workflow. Use when: running tests, typechecking, linting, verifying a change, checking build, or validating code before committing in mcp/springbreaker.'
argument-hint: 'Optional: "typecheck", "test", "lint", or "all" (default all)'
user-invocable: true
---

# Run Tests, Typecheck & Lint

Standard verification workflow for the SpringBreaker MCP server. Run this before
considering any change complete.

## When to Use

- After editing code in `mcp/springbreaker/`
- Before committing or opening a PR
- When asked to "run the tests", "typecheck", "lint", or "verify the build"
- When debugging a failing test or lint error

## Working Directory

All commands run from the server package:

```bash
cd mcp/springbreaker
```

## Procedure

### 1. Typecheck

```bash
npm run typecheck
```

Runs `tsc --noEmit`. The project is strict (`strict: true`, `noUnusedLocals`,
`noUnusedParameters`, `noImplicitReturns`), so unused variables/params and implicit
returns are errors. Fix all reported issues.

### 2. Run tests

```bash
npm test
```

Runs `vitest run` (Vitest 3, `globals: true`, `environment: 'node'`). Expect ~62 passing
tests across `test/engine/` and `test/utils/`.

- Watch mode: `npm run test:watch`
- Coverage: `npm run test:coverage`

If a test fails, read the failure, fix the source, and re-run. Do not weaken assertions to
make tests pass.

### 3. Lint

```bash
npm run lint
```

Runs `eslint src/ test/` (type-aware, `@typescript-eslint`). `no-unused-vars` is an error
(arguments prefixed `_` are ignored). Auto-fix with `npm run lint:fix`, then re-run.

> **Known issue:** lint currently fails to start — ESLint 9 requires an
> `eslint.config.js`, but the repo only has `.eslintrc.json`. Until migrated, lint is
> non-functional. Do not treat this as a code failure; typecheck + tests are the gate.

### 4. Build (optional but recommended)

```bash
npm run build
```

Compiles `tsc` → `dist/`. Confirms the ESM/Node16 module resolution and `.js` import
suffixes are correct.

## Troubleshooting

- **ESM import errors** — relative imports must use the `.js` suffix
  (`import { x } from "../utils/logger.js"`), never `require`.
- **`parseTagValue` regressions** — if POM tests or `pom-worker.ts` behavior changes,
  verify `parseTagValue: false` is still set (see `AGENTS.md`).
- **Lint "unused" errors** — remove the variable or prefix the arg with `_`.

## Related

- Full project conventions & pitfalls: [`AGENTS.md`](../../../AGENTS.md)
- Contribution checklist: [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)
