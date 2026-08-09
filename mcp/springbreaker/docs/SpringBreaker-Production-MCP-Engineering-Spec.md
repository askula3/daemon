# SpringBreaker — Production-Grade MCP Engineering Specification

## Status

**Purpose:** Implementation and hardening specification for the coding agent working on SpringBreaker.

**Goal:** Turn SpringBreaker into a production-ready MCP for deterministic Spring Boot Maven dependency vulnerability remediation using company Sonatype IQ Server, Nexus Repository, and Maven.

**Core principle:**

> The LLM is the commander. SpringBreaker is the engineer.

The LLM must not be responsible for dependency reasoning, version selection, graph analysis, Nexus interpretation, XML manipulation, concurrency management, or security policy decisions. Those responsibilities belong inside SpringBreaker.

The system must remain useful with smaller models such as GPT-5 Mini or GPT-4o. A stronger model may improve interaction, but must never be required for correctness.

---

# 1. Product Definition

SpringBreaker is a **deterministic remediation engine exposed through MCP**.

Intended flow:

```text
User: "Resolve HIGH and MEDIUM vulnerabilities."

LLM
  ↓
build_plan

SpringBreaker
  inspect → IQ → Maven graph → ownership → candidates → policy
  → dependency-aware DAG

LLM
  ↓
present plan / obtain approval

LLM
  ↓
execute_plan

SpringBreaker
  safe parallel execution → Maven verify → IQ rescan → replan

LLM
  ↓
summarize
```

The AI should not need to understand IQ Server, Nexus, Maven dependency mediation, or Spring Boot BOM mechanics.

---

# 2. Non-Negotiable Principles

## Deterministic

For the same project state, IQ report, Nexus state, policy, and Git revision, SpringBreaker should produce the same decisions.

## Safe

Prefer the smallest safe remediation over the newest dependency.

## Policy-driven

Hard rules live in code/configuration, not in prompts.

## Model-independent

Correctness must not depend on the reasoning ability of the LLM.

## Verifiable

A dependency is not considered successfully remediated until verification confirms it.

## Reversible

SpringBreaker must never destroy unrelated developer changes.

## Fast

Parallelize independent network work and dependency tasks, but use bounded concurrency.

---

# 3. Public MCP Surface

Keep the public MCP API intentionally small.

### `inspect_project`

Read-only project and capability inspection.

### `build_plan`

Perform all expensive/domain-specific analysis and create an immutable remediation plan.

### `execute_plan`

Execute an approved plan only after validating that the project has not changed unexpectedly.

### `verify`

Run Maven verification and IQ verification.

### `summarize`

Return a concise, structured result suitable for an AI model.

Do not expose low-level MCP tools such as:

- `search_nexus`
- `get_iq_report`
- `dependency_tree`
- `find_owner`
- `edit_pom`
- `run_maven`

Those are internal services.

---

# 4. Project Inspection

Determine:

- project root
- Git branch
- Git revision
- working-tree status
- Maven wrapper
- Maven version
- Java version
- Spring Boot version
- parent POM
- dependencyManagement
- modules
- Maven profiles
- IQ application identity
- capabilities

Reject unsupported projects clearly.

Never silently switch Git branches.

If the user explicitly requests another branch, inspect that branch deliberately and report what was selected.

---

# 5. Git Safety

Before modification:

- capture branch
- capture HEAD
- capture working-tree status
- capture hashes of relevant files
- detect unrelated user changes

Never:

- `git reset --hard`
- delete unrelated changes
- overwrite user edits
- switch branches automatically
- commit without explicit request
- push anything

A plan becomes invalid if relevant project state changes after plan creation.

---

# 6. IQ Server Integration

IQ is the authoritative vulnerability source.

The IQ worker must:

- authenticate securely
- identify the correct application
- resolve the requested branch/report
- retrieve the report
- normalize violations
- preserve IQ identifiers
- preserve severity
- preserve policy information
- preserve remediation recommendations
- cache the report during one run

Do not repeatedly download the same report during planning.

---

# 7. Severity

Support:

- CRITICAL
- HIGH
- MEDIUM
- LOW

Allow combinations such as:

```text
HIGH
HIGH + MEDIUM
CRITICAL + HIGH
ALL
```

The MCP should receive structured severity values from the LLM, not parse arbitrary prose itself.

---

# 8. Maven Dependency Graph

Build a complete graph for the relevant project.

Determine:

- direct vs transitive
- all dependency paths
- owning dependency
- scope
- dependencyManagement source
- explicit version
- inherited version
- Spring Boot managed status
- property-managed version
- likely usage

Example:

```text
application
  └── poi-ooxml
       └── commons-compress
            └── vulnerable
```

Normally fix `poi-ooxml`, not `commons-compress`.

---

# 9. Remediation Priority

Use this priority order:

1. Remove a dependency if it is proven unused and policy permits removal.
2. Upgrade Spring Boot parent/BOM when it safely fixes vulnerabilities.
3. Upgrade the owning dependency of a vulnerable transitive component.
4. Upgrade the direct dependency itself.
5. Apply an IQ recommended version.
6. Select the best policy-approved Nexus version.
7. Override a vulnerable transitive dependency.
8. Exclude and replace.

Do not skip to a lower-priority solution when a higher-priority solution can safely resolve the issue.

---

# 10. Spring Boot Parent/BOM Rule

Spring Boot is a coordinated dependency platform.

Before overriding Spring-managed dependencies:

1. Detect Boot parent/BOM.
2. Find allowed newer Boot versions.
3. Determine which vulnerabilities each candidate fixes.
4. Prefer a compatible patch upgrade that fixes multiple vulnerabilities.
5. Apply and re-analyze.
6. Remove now-unnecessary dependency tasks.

Defaults:

```text
patch: allowed
minor: configurable
major: disabled
```

Never blindly upgrade across major Boot versions.

Consider Java compatibility.

---

# 11. Dependency Ownership Rule

For every vulnerable transitive dependency:

1. Find every dependency path.
2. Identify owners.
3. Determine whether an owner upgrade fixes the vulnerability.
4. Determine whether the vulnerable component is shared.
5. Prefer an owner upgrade over a direct transitive override.

If several owners exist, model them explicitly.

Never assume the first dependency path is the only cause.

---

# 12. Unused Dependencies

`mvn dependency:analyze` is evidence, not absolute truth.

Reflection, ServiceLoader, Spring scanning, runtime configuration, generated code, plugins, and framework conventions can make a dependency appear unused.

Use confidence:

```text
HIGH
MEDIUM
LOW
```

Automatic removal should require high confidence unless policy explicitly says otherwise.

If uncertain, report a recommendation rather than silently deleting the dependency.

---

# 13. IQ Recommendation

Prefer IQ's suggested fixed version when:

- it exists in Nexus
- coordinates match
- it is a stable GA release
- policy allows it
- it is not a snapshot
- it is not alpha/beta/milestone/RC
- it is not an unwanted vendor-specific build

IQ is a strong signal, not an unconditional command.

---

# 14. Nexus Version Policy

Nexus lookups must be bounded and concurrent.

Default acceptable:

- GA
- stable
- company repository available
- policy-compatible semantic version

Reject by default:

- SNAPSHOT
- alpha
- beta
- milestone
- RC
- Red Hat/vendor-specific variants

Do not use naive substring matching as the only release classifier.

Use a real version parser plus explicit release metadata rules.

If a version cannot be classified confidently, reject it conservatively.

---

# 15. Version Selection

Never implement:

```text
select latest version
```

as the entire remediation algorithm.

Instead:

```text
select best policy-approved version for this remediation target
```

Example:

```text
current: 4.2.1

available:
4.2.2
4.3.0
4.3.1
5.0.0

default conservative candidate:
4.2.2
```

An IQ recommendation can select a newer version when policy allows it.

Major upgrades require explicit policy permission.

---

# 16. Policy Engine

Example:

```json
{
  "severity": ["HIGH", "MEDIUM"],
  "preferParentUpgrade": true,
  "preferOwningDependency": true,
  "preferIqRecommendation": true,
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

Policy precedence:

```text
system defaults
    ↓
project policy
    ↓
explicit user request
```

User requests must not bypass hard safety constraints.

Keep policy decisions centralized.

---

# 17. Planner

The planner is the core of SpringBreaker.

It must produce a **DAG (Directed Acyclic Graph)** rather than a sequential checklist.

Every task should contain at least:

```ts
interface RemediationTask {
  id: string;
  action: string;
  target: string;
  dependencies: string[];
  conflicts: string[];
  expectedFixes: string[];
  risk: "LOW" | "MEDIUM" | "HIGH";
  confidence: number;
  verification: VerificationSpec;
  rollback: RollbackSpec;
}
```

Tasks with no dependency/conflict relationship should be eligible for parallel execution.

The planner, not the LLM, determines this.

---

# 18. Parallelism

Use internal workers, not LLM subagents, for deterministic operations.

Examples:

```text
NexusWorker
 ├── lookup Guava
 ├── lookup POI
 ├── lookup Commons IO
 └── lookup Logback
```

These requests should execute concurrently with a configurable limit.

Never use unbounded `Promise.all()` against company Nexus.

Recommended initial defaults:

```text
Nexus concurrency: 5
IQ concurrency: 2
Maven execution: 1
POM mutation: 1
```

Tune using measurements.

---

# 19. Smart Batching

Do not verify every independent change separately.

Prefer:

```text
plan
 ↓
apply independent safe tasks
 ↓
mvn verify
 ↓
IQ scan
 ↓
replan
```

Separate high-risk tasks into their own batches.

Batch boundaries should consider:

- conflicts
- risk
- dependency relationships
- expected impact
- verification cost

---

# 20. Replanning

Replanning is mandatory after meaningful state changes.

Example:

```text
Initial:
HIGH = 12
MEDIUM = 24

Spring Boot upgrade

↓

HIGH = 4
MEDIUM = 9

↓

discard obsolete tasks

↓

rebuild plan
```

Never execute a stale plan.

A successful framework upgrade may eliminate many planned dependency changes.

---

# 21. Plan Immutability

Every plan should contain:

```text
planId
projectFingerprint
gitRevision
iqReportId
policyHash
createdAt
```

Before execution validate:

- same project
- same branch
- same relevant files
- same Git revision
- same policy
- assumptions still valid

If not:

```text
PLAN INVALIDATED
```

Require replanning.

---

# 22. POM Modification

Never use fragile regex-only XML editing.

Use a proper XML parser or Maven-aware editing strategy.

Preserve where possible:

- formatting
- comments
- namespaces
- properties
- ordering
- unrelated content

Prefer changing an existing property over introducing duplicate explicit versions.

Before adding a version check:

1. explicit dependency
2. parent management
3. Spring Boot BOM
4. property
5. dependencyManagement
6. transitive mediation

Avoid POM clutter.

---

# 23. Multi-Module Maven

Support:

```text
root
 ├── module-a
 ├── module-b
 └── module-c
```

Determine whether a version is:

- root-managed
- module-specific
- inherited
- property-controlled
- dependencyManagement-controlled

One root-level property should not be duplicated across modules.

---

# 24. Maven Execution

Prefer:

```text
./mvnw
```

when available.

Fallback:

```text
mvn
```

Use process APIs with argument arrays.

Do not construct arbitrary shell commands from model input.

Map high-level operations to fixed, known Maven commands.

---

# 25. Security

Treat all external data as untrusted:

- IQ responses
- Nexus metadata
- POM content
- Maven output
- Git branch names
- artifact metadata

Validate:

- filesystem paths
- URLs
- artifact coordinates
- versions
- branch names
- process arguments

Never execute arbitrary model-provided commands.

Never expose credentials in logs, plans, errors, or MCP responses.

Use least-privilege IQ/Nexus credentials.

Do not document real admin credentials.

---

# 26. HTTP Reliability

IQ and Nexus clients need:

- timeouts
- connection reuse
- bounded concurrency
- retries
- exponential backoff
- jitter
- retryable status classification
- non-retryable status classification

Do not retry authentication failures indefinitely.

Do not blindly retry all 4xx responses.

---

# 27. Caching

Cache during a planning/execution run:

- IQ report
- Nexus version metadata
- artifact existence
- Maven dependency graph
- project inspection

Avoid long-lived global caches unless invalidation is well-defined.

Correctness is more important than cache hit rate.

---

# 28. Failure Classification

Use structured failures.

Example:

```json
{
  "status": "FAILED",
  "code": "NEXUS_TIMEOUT",
  "retryable": true,
  "message": "Nexus request timed out",
  "taskId": "1.3"
}
```

Recommended classifications:

```text
NO_FIX_AVAILABLE
POLICY_BLOCKED
VERSION_NOT_AVAILABLE
INCOMPATIBLE_UPGRADE
BUILD_FAILED
IQ_UNAVAILABLE
NEXUS_UNAVAILABLE
PROJECT_CHANGED
PLAN_INVALID
UNKNOWN
```

An unresolved vulnerability is not necessarily a system failure.

---

# 29. No False Success

Never say:

```text
All vulnerabilities resolved
```

unless IQ verification confirms it.

Track separate states:

```text
PLANNED
EXECUTED
BUILD_VERIFIED
IQ_VERIFIED
REMEDIATED
UNRESOLVED
FAILED
SKIPPED
```

---

# 30. Verification

After modifications:

1. Maven verification.
2. IQ verification.

At minimum:

```text
mvn verify
```

Prefer Maven Wrapper.

If Maven fails:

1. identify responsible task/batch
2. capture diagnostics
3. rollback safely
4. replan
5. continue only if safe

Do not blindly retry deterministic build failures.

---

# 31. IQ Post-Verification

Compare:

```text
before
vs
after
```

for requested severities.

A vulnerability is successfully remediated only when the relevant IQ violation disappears or is demonstrably resolved.

---

# 32. Rollback

Before mutation:

- capture relevant file hashes
- record original contents/state
- record changed files

On failure:

- restore only files changed by SpringBreaker
- preserve unrelated developer changes

Never use destructive Git reset operations.

---

# 33. Confidence and Risk

Every automated task should include confidence and risk.

### LOW risk

- Spring Boot patch
- IQ-recommended compatible patch
- isolated patch upgrade
- high-confidence unused dependency removal

### MEDIUM risk

- minor dependency upgrade
- shared dependency owner upgrade
- transitive override

### HIGH risk

- major upgrade
- framework migration
- uncertain dependency removal
- broad graph impact

Default policy should not automatically execute HIGH-risk tasks.

---

# 34. Explainability

Every task needs:

- target
- current version
- proposed version
- reason
- source of recommendation
- expected vulnerabilities fixed
- risk
- confidence
- verification strategy

Every unresolved vulnerability needs a reason.

Example:

```text
HIGH remains unresolved.

Reason:
- IQ has no fixed version.
- Nexus latest allowed GA is not fixed.
- Owning dependency requires a major upgrade.
- Major upgrades are disabled by policy.
```

This is a valid analysis result, not a generic error.

---

# 35. AI-Friendly Output

Do not return huge raw IQ/Maven/Nexus payloads.

Return compact structured summaries.

Good:

```text
HIGH: 12
MEDIUM: 24

Top actions:
1. Spring Boot patch → fixes 7
2. POI upgrade → fixes 3
3. Remove unused dependency → fixes 1
```

The model should receive enough information to communicate decisions, not thousands of lines of implementation data.

---

# 36. Model Independence

The MCP must remain correct if the model:

- calls a tool twice
- retries a tool
- loses context
- calls tools in an unexpected order
- provides incomplete input
- is a small model

Design tools to be state-aware and idempotent where possible.

The model should mostly orchestrate:

```text
build_plan
execute_plan
verify
summarize
```

---

# 37. Idempotency

`inspect_project`:
- read-only

`build_plan`:
- read-only

`execute_plan`:
- tied to plan/task ids
- must not apply the same mutation twice

`verify`:
- safe to repeat

`summarize`:
- safe to repeat

Execution state should prevent duplicate mutations.

---

# 38. State

Track:

```text
project
plan
execution
task
verification
```

At minimum:

```text
planId
executionId
createdAt
updatedAt
status
gitRevision
projectFingerprint
policyHash
```

If execution can outlive the Node process, state must survive process restart or execution must be explicitly resumable/restartable.

---

# 39. Prevent Infinite Loops

Set configurable limits:

- maximum replans
- maximum execution batches
- maximum modifications
- maximum Maven failures
- maximum IQ rescans

If vulnerability state stops improving:

```text
STOP

Reason:
No measurable vulnerability reduction after N iterations.
```

Never loop indefinitely.

---

# 40. Performance Strategy

Expensive operations:

- IQ calls
- Nexus calls
- Maven builds
- IQ rescans

Cheap operations:

- graph processing
- policy evaluation
- version filtering
- plan generation

Therefore:

- parallelize independent Nexus work
- cache IQ report
- cache Nexus metadata during a run
- avoid repeated Maven builds
- batch safe changes
- replan after meaningful batches

---

# 41. Observability

Use structured logging.

Every operation should carry:

```text
executionId
planId
taskId
project
component
operation
duration
status
```

Never log secrets.

Useful metrics:

- plan duration
- IQ latency
- Nexus latency
- Maven duration
- tasks planned
- tasks executed
- tasks skipped
- tasks failed
- vulnerabilities fixed
- vulnerabilities remaining
- retry count
- concurrency utilization

---

# 42. Testing Strategy

## Unit tests

Cover:

- severity filtering
- version parsing
- version filtering
- version ranking
- policy evaluation
- dependency ownership
- graph construction
- conflict detection
- DAG construction
- task ranking
- unresolved classification

## Integration tests

Mock:

- IQ
- Nexus
- Maven process
- Git where appropriate

Test complete workflows.

## Fixture projects

Maintain fixtures for:

1. direct vulnerability
2. transitive vulnerability
3. Spring Boot managed vulnerability
4. multiple owners
5. unused dependency
6. IQ recommendation
7. no IQ recommendation
8. Red Hat candidate
9. snapshot candidate
10. major-only fix
11. conflicting upgrades
12. multi-module project
13. property-managed dependency
14. dependencyManagement override
15. dirty Git tree
16. Maven failure
17. IQ failure
18. Nexus timeout

---

# 43. Golden Plan Tests

For fixed:

```text
POM
+
IQ fixture
+
Nexus fixture
+
policy
```

assert:

```text
expected plan
```

exactly.

This is essential because the planner is the core product.

---

# 44. DAG Invariants

Tests must guarantee:

- no cycles
- no self-dependencies
- every dependency references an existing task
- every executable task has satisfied prerequisites
- independent tasks are parallelizable
- conflicting tasks never execute concurrently
- completed tasks are not executed again
- obsolete tasks disappear after replanning

---

# 45. Failure Injection

Explicitly test:

- Nexus timeout
- Nexus 404
- Nexus 500
- IQ 401
- IQ 500
- Maven compilation failure
- Maven test failure
- malformed POM
- deleted project
- changed branch
- changed POM after planning
- process timeout

Expected behavior must be safe and deterministic.

---

# 46. Property-Based Invariants

Useful invariants:

- rejected versions are never selected
- disabled major upgrades are never selected
- snapshots are never selected when disabled
- unrelated files are never modified
- credentials never appear in plan serialization
- arbitrary shell commands are never executed
- every plan task is explainable
- every successful remediation has verification evidence

---

# 47. Recommended Internal Structure

Adapt the existing codebase rather than rewriting working components unnecessarily.

Recommended conceptual structure:

```text
src/
├── tools/
│   ├── inspect-project
│   ├── build-plan
│   ├── execute-plan
│   ├── verify
│   └── summarize
│
├── engine/
│   ├── planner/
│   ├── executor/
│   ├── scheduler/
│   ├── replanner/
│   └── policy/
│
├── analyzers/
│   ├── project
│   ├── dependency
│   ├── ownership
│   ├── spring-boot
│   └── unused
│
├── workers/
│   ├── iq
│   ├── nexus
│   ├── maven
│   ├── git
│   └── pom
│
├── types/
└── utils/
```

---

# 48. Implementation Priority

## P0 — Correctness and safety

Implement/harden first:

1. Git safety
2. project identification
3. IQ report retrieval
4. Maven graph correctness
5. Spring Boot parent/BOM detection
6. dependency ownership
7. version policy
8. IQ recommendation validation
9. Nexus version resolution
10. deterministic planner
11. DAG correctness
12. safe POM modification
13. Maven verification
14. IQ verification
15. rollback
16. plan invalidation
17. no-false-success reporting

## P1 — Production hardening

1. bounded concurrency
2. retry/backoff
3. caching
4. structured logging
5. persistent/recoverable state
6. failure classification
7. multi-module support
8. golden fixtures
9. security hardening
10. idempotency

## P2 — Optimization

1. smarter batching
2. improved task ranking
3. better caching
4. incremental graph analysis
5. parallel planning analysis
6. richer summaries

## P3 — Future

Possible future integrations:

- other vulnerability scanners
- Gradle
- GitHub/GitLab PR creation
- CI mode
- scheduled remediation
- automated commits

Do not expand scope until Maven/Spring Boot/IQ/Nexus is excellent.

---

# 49. Things Explicitly Not to Build

Do not:

- add dozens of MCP tools
- let the LLM select versions
- let the LLM edit POM files directly
- use unbounded Nexus concurrency
- blindly select latest versions
- blindly trust dependency:analyze
- automatically perform major upgrades
- automatically switch branches
- reset the Git tree
- overwrite user changes
- expose credentials
- dump huge IQ reports into model context
- use LLM subagents for deterministic HTTP requests
- run Maven after every independent change
- claim success without IQ verification
- execute a stale plan
- introduce abstractions that do not improve correctness, safety, speed, testability, or observability

---

# 50. Definition of Done

SpringBreaker is production-ready when:

## Correctness

- dependency graph is reliable
- dependency ownership is reliable
- Spring Boot management is detected correctly
- IQ recommendations are validated
- Nexus versions are filtered correctly
- planner decisions are deterministic

## Safety

- user changes are never lost
- stale plans are rejected
- arbitrary shell execution is impossible
- credentials are protected
- rollback is reliable
- major upgrades require policy permission

## Performance

- independent Nexus calls run concurrently
- concurrency is bounded
- IQ reports are reused
- Maven builds are batched
- replanning removes obsolete work

## MCP quality

- small public tool surface
- strict schemas
- concise responses
- clear tool descriptions
- idempotent operations
- structured errors

## Testing

- unit tests for decision logic
- worker integration tests
- realistic Maven fixtures
- golden plan tests
- failure injection
- DAG invariant tests

## User experience

These commands must work reliably:

```text
Resolve HIGH vulnerabilities.
```

```text
Resolve HIGH and MEDIUM vulnerabilities.
```

```text
Resolve HIGH vulnerabilities on develop.
```

```text
Create a remediation plan but don't modify anything.
```

```text
Execute the approved plan.
```

The user should not need to understand IQ Server, Nexus, Maven internals, or the internal DAG.

---

# 51. Final Engineering Rule

Do not optimize SpringBreaker for impressive AI behavior.

Optimize it for **boring, deterministic correctness**.

The desired architecture is:

```text
USER INTENT
    ↓
SMALL LLM
    ↓
MCP TOOL
    ↓
DETERMINISTIC ENGINE
    ↓
IQ + MAVEN + NEXUS
    ↓
DAG PLANNER / EXECUTOR
    ↓
SAFE MUTATION
    ↓
MAVEN VERIFICATION
    ↓
IQ RESCAN
    ↓
REPLAN
    ↓
RESULT
```

The final quality bar is:

> A small model can ask SpringBreaker to reduce the project's HIGH/MEDIUM vulnerability score, and SpringBreaker consistently makes the smallest, safest, policy-compliant changes that actually work.

The MCP should do the hard work.

The model should only command it.
