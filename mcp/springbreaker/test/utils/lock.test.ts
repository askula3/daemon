import { describe, it, expect } from "vitest";
import {
  withProjectLock,
  isProjectLocked,
  lockedProjectCount,
} from "../../src/utils/lock.js";

describe("withProjectLock", () => {
  it("executes a function and returns its result", async () => {
    const result = await withProjectLock("/test/project", async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it("serializes concurrent calls to the same project", async () => {
    const order: number[] = [];

    // Start two concurrent calls to the same project
    const p1 = withProjectLock("/test/serial", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
      return "first";
    });

    const p2 = withProjectLock("/test/serial", async () => {
      order.push(2);
      return "second";
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    // First call must complete before second
    expect(order).toEqual([1, 2]);
    expect(r1).toBe("first");
    expect(r2).toBe("second");
  });

  it("allows concurrent calls to different projects", async () => {
    const order: string[] = [];

    const p1 = withProjectLock("/test/project-a", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("a");
      return "a";
    });

    const p2 = withProjectLock("/test/project-b", async () => {
      order.push("b");
      return "b";
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    // Different projects can run concurrently
    expect(order).toEqual(["b", "a"]);
    expect(r1).toBe("a");
    expect(r2).toBe("b");
  });

  it("cleans up lock entry after completion", async () => {
    await withProjectLock("/test/cleanup", async () => {
      return "done";
    });

    expect(isProjectLocked("/test/cleanup")).toBe(false);
  });

  it("cleans up lock entry after error", async () => {
    await expect(
      withProjectLock("/test/error-cleanup", async () => {
        throw new Error("test error");
      }),
    ).rejects.toThrow("test error");

    expect(isProjectLocked("/test/error-cleanup")).toBe(false);
  });

  it("isProjectLocked returns true during execution", async () => {
    let lockedDuringExecution = false;

    const p = withProjectLock("/test/check-lock", async () => {
      lockedDuringExecution = isProjectLocked("/test/check-lock");
      return "done";
    });

    await p;
    expect(lockedDuringExecution).toBe(true);
    expect(isProjectLocked("/test/check-lock")).toBe(false);
  });

  it("lockedProjectCount tracks active locks", async () => {
    const initial = lockedProjectCount();

    const p = withProjectLock("/test/count", async () => {
      expect(lockedProjectCount()).toBe(initial + 1);
      return "done";
    });

    await p;
    expect(lockedProjectCount()).toBe(initial);
  });

  it("error in one caller does not block the next", async () => {
    // First call fails
    await expect(
      withProjectLock("/test/error-chain", async () => {
        throw new Error("first fails");
      }),
    ).rejects.toThrow("first fails");

    // Second call should succeed (not blocked by the first)
    const result = await withProjectLock("/test/error-chain", async () => {
      return "second succeeds";
    });
    expect(result).toBe("second succeeds");
  });
});
