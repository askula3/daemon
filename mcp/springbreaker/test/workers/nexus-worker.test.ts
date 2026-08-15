import { describe, it, expect, vi, beforeEach } from "vitest";
import { NexusWorker } from "../../src/workers/nexus-worker.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("NexusWorker", () => {
  let worker: NexusWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new NexusWorker("http://nexus:8081", "admin", "password");
  });

  describe("search", () => {
    it("returns mapped artifacts from search results", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              group: "com.example",
              name: "lib",
              version: "1.0.0",
              repository: "maven-central",
              format: "maven2",
              assets: [
                {
                  mimeType: "application/java-archive",
                  downloadUrl:
                    "http://nexus/com/example/lib/1.0.0/lib-1.0.0.jar",
                  path: "com/example/lib/1.0.0/lib-1.0.0.jar",
                  checksums: {},
                  lastModified: "2024-01-01",
                  lastUploaded: "2024-01-01",
                  extraFields: {},
                },
              ],
            },
          ],
        }),
      );

      const results = await worker.search("com.example", "lib");

      expect(results).toHaveLength(1);
      expect(results[0].group).toBe("com.example");
      expect(results[0].name).toBe("lib");
      expect(results[0].version).toBe("1.0.0");
    });

    it("returns empty array when no results", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ items: [] }));

      const results = await worker.search("com.example", "nonexistent");
      expect(results).toHaveLength(0);
    });
  });

  describe("suggestUpgrade", () => {
    it("suggests latest stable patch version", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              group: "com.example",
              name: "lib",
              version: "1.0.2",
              repository: "r",
              format: "m2",
              assets: [
                {
                  mimeType: "jar",
                  downloadUrl: "",
                  path: "",
                  checksums: {},
                  lastModified: "",
                  lastUploaded: "",
                  extraFields: {},
                },
              ],
            },
            {
              group: "com.example",
              name: "lib",
              version: "1.0.1",
              repository: "r",
              format: "m2",
              assets: [
                {
                  mimeType: "jar",
                  downloadUrl: "",
                  path: "",
                  checksums: {},
                  lastModified: "",
                  lastUploaded: "",
                  extraFields: {},
                },
              ],
            },
            {
              group: "com.example",
              name: "lib",
              version: "1.0.0",
              repository: "r",
              format: "m2",
              assets: [
                {
                  mimeType: "jar",
                  downloadUrl: "",
                  path: "",
                  checksums: {},
                  lastModified: "",
                  lastUploaded: "",
                  extraFields: {},
                },
              ],
            },
          ],
        }),
      );

      const result = await worker.suggestUpgrade("com.example", "lib", "1.0.0");

      expect(result.suggested).toBe("1.0.2");
      expect(result.type).toBe("patch");
    });

    it("rejects snapshots when not allowed", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              group: "com.example",
              name: "lib",
              version: "1.1.0-SNAPSHOT",
              repository: "r",
              format: "m2",
              assets: [
                {
                  mimeType: "jar",
                  downloadUrl: "",
                  path: "",
                  checksums: {},
                  lastModified: "",
                  lastUploaded: "",
                  extraFields: {},
                },
              ],
            },
            {
              group: "com.example",
              name: "lib",
              version: "1.0.1",
              repository: "r",
              format: "m2",
              assets: [
                {
                  mimeType: "jar",
                  downloadUrl: "",
                  path: "",
                  checksums: {},
                  lastModified: "",
                  lastUploaded: "",
                  extraFields: {},
                },
              ],
            },
          ],
        }),
      );

      const result = await worker.suggestUpgrade(
        "com.example",
        "lib",
        "1.0.0",
        {
          allowSnapshots: false,
        },
      );

      expect(result.suggested).toBe("1.0.1");
      expect(result.type).toBe("patch");
    });

    it("skips major upgrades when not allowed", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              group: "com.example",
              name: "lib",
              version: "2.0.0",
              repository: "r",
              format: "m2",
              assets: [
                {
                  mimeType: "jar",
                  downloadUrl: "",
                  path: "",
                  checksums: {},
                  lastModified: "",
                  lastUploaded: "",
                  extraFields: {},
                },
              ],
            },
            {
              group: "com.example",
              name: "lib",
              version: "1.0.1",
              repository: "r",
              format: "m2",
              assets: [
                {
                  mimeType: "jar",
                  downloadUrl: "",
                  path: "",
                  checksums: {},
                  lastModified: "",
                  lastUploaded: "",
                  extraFields: {},
                },
              ],
            },
          ],
        }),
      );

      const result = await worker.suggestUpgrade(
        "com.example",
        "lib",
        "1.0.0",
        {
          allowMajor: false,
        },
      );

      expect(result.suggested).toBe("1.0.1");
      expect(result.type).toBe("patch");
    });

    it("allows major upgrades when policy permits", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              group: "com.example",
              name: "lib",
              version: "2.0.0",
              repository: "r",
              format: "m2",
              assets: [
                {
                  mimeType: "jar",
                  downloadUrl: "",
                  path: "",
                  checksums: {},
                  lastModified: "",
                  lastUploaded: "",
                  extraFields: {},
                },
              ],
            },
          ],
        }),
      );

      const result = await worker.suggestUpgrade(
        "com.example",
        "lib",
        "1.0.0",
        {
          allowMajor: true,
        },
      );

      expect(result.suggested).toBe("2.0.0");
      expect(result.type).toBe("major");
    });

    it("returns null when no newer version exists", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              group: "com.example",
              name: "lib",
              version: "1.0.0",
              repository: "r",
              format: "m2",
              assets: [
                {
                  mimeType: "jar",
                  downloadUrl: "",
                  path: "",
                  checksums: {},
                  lastModified: "",
                  lastUploaded: "",
                  extraFields: {},
                },
              ],
            },
          ],
        }),
      );

      const result = await worker.suggestUpgrade("com.example", "lib", "1.0.0");

      expect(result.suggested).toBeNull();
      expect(result.type).toBe("none");
    });
  });
});
