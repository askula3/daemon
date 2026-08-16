import { describe, it, expect, vi } from "vitest";
import { withRetry, isRetryableHttpStatus } from "../../src/utils/retry.js";

describe("retry utilities", () => {
  describe("isRetryableHttpStatus", () => {
    it("returns true for 429 (Too Many Requests)", () => {
      expect(isRetryableHttpStatus(429)).toBe(true);
    });

    it("returns true for 5xx server errors", () => {
      expect(isRetryableHttpStatus(500)).toBe(true);
      expect(isRetryableHttpStatus(502)).toBe(true);
      expect(isRetryableHttpStatus(503)).toBe(true);
    });

    it("returns false for 4xx client errors", () => {
      expect(isRetryableHttpStatus(400)).toBe(false);
      expect(isRetryableHttpStatus(401)).toBe(false);
      expect(isRetryableHttpStatus(403)).toBe(false);
      expect(isRetryableHttpStatus(404)).toBe(false);
    });
  });

  describe("withRetry", () => {
    it("returns result on first success", async () => {
      const fn = vi.fn().mockResolvedValue("ok");
      const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on failure and succeeds", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockResolvedValue("ok");

      const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("throws after exhausting retries", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("always fails"));

      await expect(
        withRetry(fn, { maxRetries: 2, baseDelayMs: 1 }),
      ).rejects.toThrow("always fails");
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("does not retry non-retryable errors", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("auth failed"));

      await expect(
        withRetry(fn, {
          maxRetries: 3,
          baseDelayMs: 1,
          isRetryable: () => false,
        }),
      ).rejects.toThrow("auth failed");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("respects custom isRetryable", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("429"), { status: 429 }))
        .mockResolvedValue("ok");

      const result = await withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 1,
        isRetryable: (err) => (err as { status?: number }).status === 429,
      });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("cancels exponential backoff without another attempt", async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(new Error("transient"));
      const result = withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 10_000,
        signal: controller.signal,
      });

      await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
      controller.abort(new Error("cancelled"));

      await expect(result).rejects.toThrow("cancelled");
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
