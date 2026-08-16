import { describe, it, expect, vi, beforeEach } from "vitest";
import { logger, createChildLogger, startTimer, LogLevel } from "../../src/utils/logger.js";

describe("logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.setLevel("debug");
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  describe("log levels", () => {
    it("respects log level filtering", () => {
      logger.setLevel("warn");
      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      logger.error("error msg");

      expect(stderrSpy).toHaveBeenCalledTimes(2); // only warn + error
    });

    it("logs all levels when set to debug", () => {
      logger.setLevel("debug");
      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      logger.error("error msg");

      expect(stderrSpy).toHaveBeenCalledTimes(4);
    });

    it("ignores invalid log level", () => {
      logger.setLevel("info");
      const prev = logger.getLevel();
      logger.setLevel("invalid" as unknown as LogLevel);
      expect(logger.getLevel()).toBe(prev);
    });
  });

  describe("format", () => {
    it("includes timestamp and level", () => {
      logger.info("test message");
      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
      expect(output).toContain("INFO");
      expect(output).toContain("test message");
    });

    it("includes context prefix", () => {
      logger.info("test message", "MyContext");
      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain("[MyContext]");
    });

    it("outputs to stderr only (console.error)", () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      logger.info("test");
      expect(stderrSpy).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
      stdoutSpy.mockRestore();
    });
  });
});

describe("createChildLogger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.setLevel("debug");
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("includes context in all log messages", () => {
    const log = createChildLogger("TestModule");
    log.info("hello");
    log.warn("warning");

    expect(stderrSpy).toHaveBeenCalledTimes(2);
    const output1 = stderrSpy.mock.calls[0][0] as string;
    const output2 = stderrSpy.mock.calls[1][0] as string;
    expect(output1).toContain("[TestModule]");
    expect(output2).toContain("[TestModule]");
  });

  it("propagates structured context", () => {
    const log = createChildLogger("ExecutePlan", {
      executionId: "exec-123",
      planId: "plan-456",
    });
    log.info("executing task");

    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain("executionId=exec-123");
    expect(output).toContain("planId=plan-456");
  });

  describe("withContext", () => {
    it("merges additional context", () => {
      const base = createChildLogger("ExecutePlan", { executionId: "exec-1" });
      const scoped = base.withContext({ planId: "plan-1", taskId: "task-1" });

      scoped.info("running task");

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain("executionId=exec-1");
      expect(output).toContain("planId=plan-1");
      expect(output).toContain("taskId=task-1");
    });

    it("overrides existing context keys", () => {
      const base = createChildLogger("Module", { key: "old" });
      const scoped = base.withContext({ key: "new" });

      scoped.info("test");

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain("key=new");
      expect(output).not.toContain("key=old");
    });

    it("returns a child logger with the same interface", () => {
      const base = createChildLogger("Module");
      const scoped = base.withContext({ extra: "data" });

      expect(typeof scoped.info).toBe("function");
      expect(typeof scoped.warn).toBe("function");
      expect(typeof scoped.error).toBe("function");
      expect(typeof scoped.debug).toBe("function");
      expect(typeof scoped.withContext).toBe("function");
    });
  });
});

describe("startTimer", () => {
  it("returns elapsed time in ms", async () => {
    const elapsed = startTimer();
    await new Promise(resolve => setTimeout(resolve, 50));
    const ms = elapsed();
    expect(ms).toBeGreaterThanOrEqual(40);
    expect(ms).toBeLessThan(200);
  });
});
