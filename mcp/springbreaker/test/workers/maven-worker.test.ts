import { describe, it, expect, vi, beforeEach } from "vitest";
import { MavenWorker } from "../../src/workers/maven-worker.js";

// We can't easily test spawn() without mocking child_process, but we can
// test the argument building logic by extracting it. For now, test the
// higher-level behavior through the public API with a mock.

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const EventEmitter = require("events");
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    // Simulate successful completion
    setTimeout(() => {
      child.stdout.emit("data", Buffer.from("[INFO] BUILD SUCCESS\n"));
      child.emit("close", 0);
    }, 10);
    return child;
  }),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    chmodSync: vi.fn(),
  };
});

describe("MavenWorker", () => {
  let worker: MavenWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new MavenWorker(true);
  });

  describe("constructor", () => {
    it("defaults to preferMvnw=true", () => {
      const w = new MavenWorker();
      // Access private field via serialization
      expect(JSON.stringify(w)).toContain("true");
    });

    it("accepts mavenOpts", () => {
      const w = new MavenWorker(true, "-Xmx2g");
      expect(JSON.stringify(w)).toContain("-Xmx2g");
    });
  });

  describe("execute", () => {
    it("builds correct args for dependency:tree", async () => {
      const { spawn } = await import("node:child_process");
      const result = await worker.execute("/project", ["dependency:tree"], {
        properties: { outputType: "text" },
      });

      expect(result.success).toBe(true);
      expect(spawn).toHaveBeenCalled();
      const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[0]).toContain("mvnw"); // preferMvnw=true, path is absolute via join()
      expect(callArgs[1]).toContain("dependency:tree");
      expect(callArgs[1]).toContain("-DoutputType=text");
      expect(callArgs[1]).toContain("-B"); // batch mode
    });

    it("builds correct args for clean verify with skipTests", async () => {
      const { spawn } = await import("node:child_process");
      const result = await worker.execute("/project", ["clean", "verify"], {
        skipTests: true,
      });

      expect(result.success).toBe(true);
      const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1]).toContain("clean");
      expect(callArgs[1]).toContain("verify");
      expect(callArgs[1]).toContain("-DskipTests=true");
    });

    it("includes profiles in args", async () => {
      const { spawn } = await import("node:child_process");
      await worker.execute("/project", ["build"], {
        profiles: ["prod", "fast"],
      });

      const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1]).toContain("-Pprod,fast");
    });

    it("includes thread count in args", async () => {
      const { spawn } = await import("node:child_process");
      await worker.execute("/project", ["build"], {
        threads: "4",
      });

      const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1]).toContain("-T4");
    });

    it("always includes -B for batch mode", async () => {
      const { spawn } = await import("node:child_process");
      await worker.execute("/project", ["--version"]);

      const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1]).toContain("-B");
    });

    it("sets MAVEN_OPTS when provided", async () => {
      const workerWithOpts = new MavenWorker(true, "-Xmx4g");
      const { spawn } = await import("node:child_process");
      await workerWithOpts.execute("/project", ["--version"]);

      const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[2].env.MAVEN_OPTS).toBe("-Xmx4g");
    });
  });

  describe("convenience methods", () => {
    it("cleanVerify calls execute with correct goals", async () => {
      const spy = vi.spyOn(worker, "execute");
      spy.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        duration: 100,
        success: true,
      });

      await worker.cleanVerify("/project", true);

      expect(spy).toHaveBeenCalledWith("/project", ["clean", "verify"], {
        skipTests: true,
      });
    });
  });
});
