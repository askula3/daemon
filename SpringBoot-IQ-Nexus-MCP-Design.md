# Spring Boot IQ/Nexus Remediation MCP - Design Document

## Goal

Build a deterministic MCP server (Node.js) that automates remediation of
Spring Boot Maven dependency vulnerabilities using IQ Server (Nexus
Lifecycle), Nexus Repository and Maven.

The AI is **not** responsible for dependency decisions. The MCP owns all
domain logic. The AI only orchestrates high-level commands.

Example:

> Resolve HIGH and MEDIUM vulnerabilities.

The MCP should inspect, plan, execute, verify and summarize.

------------------------------------------------------------------------

# Design Principles

-   Deterministic over heuristic.
-   Prefer encoded business rules over LLM reasoning.
-   Small models (GPT-5 Mini, GPT-4o Mini, etc.) should perform as well
    as large models.
-   Minimize unnecessary IQ scans and Maven builds.
-   Prefer safe upgrades over aggressive upgrades.
-   Every change must be verifiable and reversible.

------------------------------------------------------------------------

# High-Level Workflow

1.  Inspect project.
2.  Download IQ report.
3.  Build dependency graph.
4.  Build execution plan.
5.  Present plan.
6.  Execute approved plan.
7.  Verify build.
8.  Rescan IQ.
9.  Replan if necessary.
10. Produce summary.

------------------------------------------------------------------------

# Execution Phases

## Phase 0 -- Inspection

Collect:

-   current Git branch
-   application id
-   root pom.xml
-   modules
-   Java version
-   Spring Boot version
-   parent POM
-   dependencyManagement
-   Maven profiles

Also detect capabilities:

-   Maven
-   Spring Boot
-   Multi-module
-   IQ Server
-   Nexus
-   Git

------------------------------------------------------------------------

## Phase 1 -- IQ Analysis

Download one IQ report.

Severity filter:

-   CRITICAL
-   HIGH
-   MEDIUM
-   LOW

The prompt may specify any combination (e.g. HIGH+MEDIUM).

------------------------------------------------------------------------

## Phase 2 -- Dependency Analysis

Build complete dependency ownership graph.

Determine for every vulnerable component:

-   direct dependency
-   transitive dependency
-   imported by which dependency
-   managed by Spring Boot BOM
-   declared in dependencyManagement
-   used or unused
-   compile/runtime/test scope

Preferred tools:

-   mvn dependency:tree
-   mvn dependency:analyze
-   jdeps (optional)

------------------------------------------------------------------------

# Remediation Priority

Always try fixes in this order:

1.  Upgrade Spring Boot parent/BOM patch.
2.  Upgrade owning direct dependency.
3.  Upgrade direct dependency itself.
4.  Apply IQ suggested version.
5.  Search Nexus for latest stable GA version.
6.  Override vulnerable transitive dependency.
7.  Exclude and replace.
8.  Remove dependency if unused.

Never skip to lower priority when higher priority can solve the issue.

------------------------------------------------------------------------

# Spring Boot Rule

If a dependency version is managed by Spring Boot:

DO NOT override it immediately.

Instead:

1.  Check newer Spring Boot patch.
2.  Estimate resolved vulnerabilities.
3.  Upgrade Boot first.
4.  Recalculate remaining work.

------------------------------------------------------------------------

# IQ Recommendation Rule

If IQ suggests a fixed version:

Prefer it when:

-   exists in Nexus
-   stable GA release
-   not snapshot
-   not beta
-   not milestone
-   not RC
-   not RedHat/custom build

Otherwise search Nexus.

------------------------------------------------------------------------

# Nexus Version Policy

Accept:

-   GA releases
-   patch upgrades
-   minor upgrades (configurable)
-   major upgrades (configurable)

Reject:

-   snapshots
-   alpha
-   beta
-   rc
-   milestone
-   redhat/custom vendor versions

------------------------------------------------------------------------

# Unused Dependency Policy

If dependency is declared but unused:

-   remove it
-   compile
-   verify
-   IQ scan

Do not waste time upgrading unused libraries.

------------------------------------------------------------------------

# Policy Engine

Configuration example:

``` json
{
  "severity":["HIGH","MEDIUM"],
  "preferParentUpgrade":true,
  "preferOwningDependency":true,
  "preferIqSuggestion":true,
  "removeUnused":true,
  "allowPatch":true,
  "allowMinor":true,
  "allowMajor":false,
  "allowSnapshots":false,
  "allowRedhat":false,
  "verifyBuild":true,
  "verifyIq":true
}
```

No dependency decision should rely on the LLM.

------------------------------------------------------------------------

# Planner

Planner creates a DAG (Directed Acyclic Graph), not a sequential list.

Independent tasks execute in parallel.

Planner supports replanning after each significant batch.

------------------------------------------------------------------------

# Parallel Workers

Workers are internal implementation details.

Suggested workers:

-   IQ Worker
-   Nexus Worker
-   Maven Worker
-   Git Worker
-   XML/POM Worker

Examples:

-   20 Nexus lookups -\> parallel
-   Multiple independent dependency upgrades -\> parallel planning
-   Batch Maven verification

------------------------------------------------------------------------

# Smart Batching

Instead of:

Upgrade

Build

Scan

Upgrade

Build

Scan

Use:

Batch

↓

Build

↓

IQ Scan

↓

Replan

------------------------------------------------------------------------

# Replanning

After each batch:

1.  Build succeeds.
2.  IQ scan runs.
3.  Planner rebuilds graph.
4.  Already-resolved tasks removed automatically.

Example:

Upgrade Spring Boot

↓

Jackson fixed

↓

Tomcat fixed

↓

SnakeYAML fixed

↓

Delete remaining unnecessary tasks

------------------------------------------------------------------------

# Verification

Every task declares:

-   Preconditions
-   Expected Result
-   Verification
-   Rollback

Verification:

-   mvn clean verify
-   IQ rescan

Rollback:

-   restore pom.xml
-   restore lock state if needed

------------------------------------------------------------------------

# MCP Surface

Expose only high-level tools:

-   inspect_project
-   build_plan
-   execute_plan
-   verify
-   summarize

Hide all implementation details.

Do NOT expose:

-   search_nexus
-   parse_pom
-   find_owner
-   dependency_tree
-   etc.

Those remain internal services.

------------------------------------------------------------------------

# Plan Output

The plan should be action-oriented.

Example:

-   Upgrade Spring Boot 3.4.2 → 3.4.9
-   Upgrade Apache POI
-   Remove unused Log4j
-   Upgrade Guava

Each action includes:

-   reason
-   expected fixes
-   confidence
-   risk

------------------------------------------------------------------------

# Success Metrics

-   Maximum vulnerabilities removed.
-   Minimum POM modifications.
-   Prefer framework-aligned upgrades.
-   Clean dependency graph.
-   Deterministic results.
-   Fast execution through parallelism.
-   Works reliably with small LLMs.
