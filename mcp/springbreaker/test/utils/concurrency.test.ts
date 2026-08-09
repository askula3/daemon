import { describe, it, expect } from "vitest";
import {
  nexusLimit,
  iqLimit,
  CONCURRENCY_LIMITS,
  createConcurrencyLimiter,
} from "../../src/utils/concurrency.js";

describe("concurrency", () => {
  describe("CONCURRENCY_LIMITS", () => {
    it("has correct default limits", () => {
      expect(CONCURRENCY_LIMITS.NEXUS).toBe(5);
      expect(CONCURRENCY_LIMITS.IQ).toBe(2);
      expect(CONCURRENCY_LIMITS.MAVEN).toBe(1);
      expect(CONCURRENCY_LIMITS.POM_MUTATION).toBe(1);
    });
  });

  describe("nexusLimit", () => {
    it("limits concurrent execution", async () => {
      let running = 0;
      let maxRunning = 0;

      const task = async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(resolve => setTimeout(resolve, 50));
        running--;
      };

      // Launch 10 tasks — only 5 should run concurrently
      const tasks = Array.from({ length: 10 }, () => nexusLimit(task));
      await Promise.all(tasks);

      expect(maxRunning).toBeLessThanOrEqual(5);
    });

    it("returns task results", async () => {
      const result = await nexusLimit(async () => 42);
      expect(result).toBe(42);
    });

    it("propagates errors", async () => {
      await expect(
        nexusLimit(async () => {
          throw new Error("task failed");
        }),
      ).rejects.toThrow("task failed");
    });
  });

  describe("iqLimit", () => {
    it("limits to 2 concurrent", async () => {
      let running = 0;
      let maxRunning = 0;

      const task = async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(resolve => setTimeout(resolve, 50));
        running--;
      };

      const tasks = Array.from({ length: 6 }, () => iqLimit(task));
      await Promise.all(tasks);

      expect(maxRunning).toBeLessThanOrEqual(2);
    });
  });

  describe("createConcurrencyLimiter", () => {
    it("creates a limiter with custom concurrency", async () => {
      const limit = createConcurrencyLimiter(3);

      let running = 0;
      let maxRunning = 0;

      const task = async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(resolve => setTimeout(resolve, 50));
        running--;
      };

      const tasks = Array.from({ length: 9 }, () => limit(task));
      await Promise.all(tasks);

      expect(maxRunning).toBeLessThanOrEqual(3);
    });
  });
});
