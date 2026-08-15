import { describe, it, expect, vi, beforeEach } from "vitest";
import { IQWorker } from "../../src/workers/iq-worker.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("IQWorker", () => {
  let worker: IQWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new IQWorker(
      "http://iq-server:8070",
      "test-token",
      "test-app",
      "admin",
    );
  });

  describe("getApplication", () => {
    it("returns application info by publicId", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          applications: [
            { id: "app-id-1", name: "My App", publicId: "test-app" },
            { id: "app-id-2", name: "Other App", publicId: "other-app" },
          ],
        }),
      );

      const app = await worker.getApplication();
      expect(app.id).toBe("app-id-1");
      expect(app.publicId).toBe("test-app");
    });

    it("throws when application not found", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ applications: [] }));

      await expect(worker.getApplication()).rejects.toThrow(
        "Application not found",
      );
    });
  });
});
