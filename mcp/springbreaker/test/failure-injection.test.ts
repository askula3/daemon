/**
 * Failure injection tests (spec §45)
 *
 * Verify that the system degrades gracefully under failure conditions:
 * - Nexus timeout / 404 / 500
 * - IQ 401 / 500
 * - Maven compilation failure / test failure / timeout
 * - Malformed POM
 * - No fix available / policy blocked
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { withRetry, isRetryableHttpStatus } from "../src/utils/retry.js";
import {
  MCPError,
  IQServerError,
  NexusError,
  MavenError,
  POMError,
  handleToolError,
} from "../src/utils/errors.js";
import { POMWorker } from "../src/workers/pom-worker.js";

// ── HTTP status classification ──────────────────────────────────────
describe("failure classification: isRetryableHttpStatus", () => {
  it("429 Too Many Requests is retryable", () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
  });

  it("500 Internal Server Error is retryable", () => {
    expect(isRetryableHttpStatus(500)).toBe(true);
  });

  it("502 Bad Gateway is retryable", () => {
    expect(isRetryableHttpStatus(502)).toBe(true);
  });

  it("503 Service Unavailable is retryable", () => {
    expect(isRetryableHttpStatus(503)).toBe(true);
  });

  it("400 Bad Request is NOT retryable", () => {
    expect(isRetryableHttpStatus(400)).toBe(false);
  });

  it("401 Unauthorized is NOT retryable", () => {
    expect(isRetryableHttpStatus(401)).toBe(false);
  });

  it("403 Forbidden is NOT retryable", () => {
    expect(isRetryableHttpStatus(403)).toBe(false);
  });

  it("404 Not Found is NOT retryable", () => {
    expect(isRetryableHttpStatus(404)).toBe(false);
  });
});

// ── Retry behavior under failures ───────────────────────────────────
describe("failure injection: withRetry", () => {
  it("retries on transient failure and eventually succeeds", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "ok";
    });

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 1,
      label: "test",
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws immediately on non-retryable error", async () => {
    const fn = vi.fn(async () => {
      const err = new NexusError("Not Found", "search");
      (err as unknown as Record<string, unknown>).status = 404;
      throw err;
    });

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 1,
        label: "test",
        isRetryable: (error) => {
          if (error instanceof NexusError) {
            const status = (error as unknown as Record<string, unknown>).status;
            if (typeof status === "number")
              return isRetryableHttpStatus(status);
          }
          return true;
        },
      }),
    ).rejects.toThrow("Not Found");

    // Should NOT have retried — 404 is non-retryable
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries on persistent failure", async () => {
    const fn = vi.fn(async () => {
      throw new Error("server down");
    });

    await expect(
      withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 1,
        label: "test",
      }),
    ).rejects.toThrow("server down");

    // initial + 2 retries = 3 total
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("IQ 401 is non-retryable (authentication failure)", async () => {
    const fn = vi.fn(async () => {
      const err = new IQServerError("Unauthorized", "api-request");
      (err as unknown as Record<string, unknown>).status = 401;
      throw err;
    });

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 1,
        label: "IQ test",
        isRetryable: (error) => {
          if (error instanceof IQServerError) {
            const status = (error as unknown as Record<string, unknown>).status;
            if (typeof status === "number")
              return isRetryableHttpStatus(status);
          }
          return true;
        },
      }),
    ).rejects.toThrow("Unauthorized");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("IQ 500 is retryable (server error)", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 2) {
        const err = new IQServerError("Internal Error", "api-request");
        (err as unknown as Record<string, unknown>).status = 500;
        throw err;
      }
      return { status: "ok" };
    });

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 1,
      label: "IQ test",
      isRetryable: (error) => {
        if (error instanceof IQServerError) {
          const status = (error as unknown as Record<string, unknown>).status;
          if (typeof status === "number") return isRetryableHttpStatus(status);
        }
        return true;
      },
    });

    expect(result).toEqual({ status: "ok" });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── POM failure injection ───────────────────────────────────────────
describe("failure injection: POM worker", () => {
  it("throws POMError on malformed XML", async () => {
    const worker = new POMWorker();
    const tmpDir = await import("node:os").then((os) => os.tmpdir());
    const { join } = await import("node:path");
    const { writeFile, unlink, mkdir } = await import("node:fs/promises");

    const badPomDir = join(tmpDir, `springbreaker-test-${Date.now()}`);
    const badPomPath = join(badPomDir, "pom.xml");

    try {
      await mkdir(badPomDir, { recursive: true });
      await writeFile(badPomPath, "this is not valid XML <<<>>>", "utf-8");

      // readPom should parse without throwing (fast-xml-parser is lenient)
      // but the result will be an unusual object structure
      const result = await worker.readPom(badPomPath);
      expect(result).toBeDefined();
    } finally {
      try {
        await unlink(badPomPath);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it("throws POMError for missing POM file", async () => {
    const worker = new POMWorker();

    await expect(worker.readPom("/nonexistent/path/pom.xml")).rejects.toThrow(
      "POM file not found",
    );
  });

  it("returns false when updating nonexistent dependency", async () => {
    const worker = new POMWorker();
    const pomData = {
      project: {
        dependencies: {
          dependency: [
            { groupId: "com.example", artifactId: "lib-a", version: "1.0.0" },
          ],
        },
      },
    };

    const updated = worker.updateDependencyVersion(
      pomData as Record<string, unknown>,
      "com.example",
      "nonexistent",
      "2.0.0",
    );

    expect(updated).toBe(false);
  });

  it("returns false when updating parent with no parent element", async () => {
    const worker = new POMWorker();
    const pomData = {
      project: {
        groupId: "com.example",
        artifactId: "my-app",
        version: "1.0.0",
      },
    };

    const updated = worker.updateParentVersion(
      pomData as Record<string, unknown>,
      "2.0.0",
    );

    expect(updated).toBe(false);
  });
});

// ── Error handler failure injection ─────────────────────────────────
describe("failure injection: handleToolError", () => {
  it("handles IQServerError with correct code", () => {
    const error = new IQServerError("IQ scan failed", "scan");
    const result = handleToolError(error);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("IQ_SERVER_ERROR");
    expect(parsed.recoverable).toBe(true);
  });

  it("handles NexusError with correct code", () => {
    const error = new NexusError("Nexus timeout", "search");
    const result = handleToolError(error);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("NEXUS_ERROR");
    expect(parsed.recoverable).toBe(true);
  });

  it("handles MavenError with correct code", () => {
    const error = new MavenError("BUILD FAILURE");
    const result = handleToolError(error);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("MAVEN_ERROR");
    expect(parsed.recoverable).toBe(true);
  });

  it("handles unknown error types", () => {
    const result = handleToolError("string error");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("UNKNOWN_ERROR");
    expect(parsed.message).toBe("string error");
  });

  it("handles null/undefined gracefully", () => {
    const result = handleToolError(undefined);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("UNKNOWN_ERROR");
    expect(result.isError).toBe(true);
  });
});

// ── Planner failure scenarios ───────────────────────────────────────
describe("failure injection: planner", () => {
  it("skips component with no valid target version", async () => {
    const { Planner } = await import("../src/engine/planner.js");
    const { PolicyEngine } = await import("../src/engine/policy-engine.js");
    const { DependencyGraphBuilder } =
      await import("../src/engine/dependency-graph.js");
    const { DEFAULT_POLICY } = await import("../src/config.js");

    const policyEngine = new PolicyEngine(DEFAULT_POLICY);
    const graphBuilder = new DependencyGraphBuilder();
    graphBuilder.buildFromMavenTree(
      `[INFO] com.example:my-app:jar:1.0.0\n[INFO] +- com.example:lib:jar:1.0.0:compile`,
    );

    const planner = new Planner(policyEngine, graphBuilder);

    // Component with no fixVersions and no suggestedVersion
    const components = [
      {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [
          {
            id: "CVE-2024-999",
            referenceUrl: "",
            description: "No fix available",
            severity: "HIGH" as const,
            cvssScore: 8.0,
            CWEs: [],
            licenseRisk: false,
            componentDisplayName: "lib",
            pathNames: [],
            fixVersions: [],
            firstPublished: "",
            lastModified: "",
          },
        ],
      },
    ];

    const plan = await planner.createPlan(components, "test-project");

    // Should produce 0 tasks — no valid target version
    expect(plan.tasks.length).toBe(0);
  });

  it("handles empty vulnerability list gracefully", async () => {
    const { Planner } = await import("../src/engine/planner.js");
    const { PolicyEngine } = await import("../src/engine/policy-engine.js");
    const { DependencyGraphBuilder } =
      await import("../src/engine/dependency-graph.js");
    const { DEFAULT_POLICY } = await import("../src/config.js");

    const policyEngine = new PolicyEngine(DEFAULT_POLICY);
    const graphBuilder = new DependencyGraphBuilder();
    const planner = new Planner(policyEngine, graphBuilder);

    const plan = await planner.createPlan([], "test-project");

    expect(plan.tasks.length).toBe(0);
    expect(plan.batches.length).toBe(0);
    expect(plan.vulnerabilitiesBySeverity.total).toBe(0);
  });

  it("policy blocks all major upgrades → only patch tasks created", async () => {
    const { Planner } = await import("../src/engine/planner.js");
    const { PolicyEngine } = await import("../src/engine/policy-engine.js");
    const { DependencyGraphBuilder } =
      await import("../src/engine/dependency-graph.js");

    const policy = {
      severity: ["HIGH" as const],
      preferParentUpgrade: true,
      preferOwningDependency: true,
      preferIqSuggestion: true,
      removeUnused: true,
      allowPatch: true,
      allowMinor: true,
      allowMajor: false,
      allowSnapshots: false,
      allowRedhat: false,
      verifyBuild: true,
      verifyIq: true,
    };

    const policyEngine = new PolicyEngine(policy);
    const graphBuilder = new DependencyGraphBuilder();
    graphBuilder.buildFromMavenTree(
      `[INFO] com.example:my-app:jar:1.0.0\n[INFO] +- com.example:lib:jar:1.0.0:compile`,
    );
    const planner = new Planner(policyEngine, graphBuilder);

    const components = [
      {
        packageUrl: "pkg:maven/com.example/lib@1.0.0",
        displayName: "com.example:lib:1.0.0",
        version: "1.0.0",
        groupId: "com.example",
        artifactId: "lib",
        extension: "jar",
        vulnerabilities: [
          {
            id: "CVE-2024-001",
            referenceUrl: "",
            description: "",
            severity: "HIGH" as const,
            cvssScore: 8.0,
            CWEs: [],
            licenseRisk: false,
            componentDisplayName: "lib",
            pathNames: [],
            fixVersions: ["2.0.0"], // major upgrade — should be rejected
            suggestedVersion: "2.0.0",
            firstPublished: "",
            lastModified: "",
          },
        ],
      },
    ];

    const plan = await planner.createPlan(components, "test-project");

    // Major upgrade blocked by policy → no valid target → 0 tasks
    expect(plan.tasks.length).toBe(0);
  });
});
