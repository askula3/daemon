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

  describe("filterBySeverity", () => {
    it("filters components by severity level", () => {
      const report = {
        reportId: "r1",
        applicationId: "app1",
        scanId: "s1",
        scanTime: "2024-01-01",
        components: [
          {
            packageUrl: "pkg:maven/com.example/lib@1.0.0",
            displayName: "lib",
            version: "1.0.0",
            groupId: "com.example",
            artifactId: "lib",
            extension: "jar",
            vulnerabilities: [
              {
                id: "v1",
                referenceUrl: "",
                description: "high vuln",
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
              {
                id: "v2",
                referenceUrl: "",
                description: "low vuln",
                severity: "LOW" as const,
                cvssScore: 2.0,
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
        ],
        totalVulnerabilities: 2,
        vulnerabilitiesBySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 1 },
      };

      const filtered = worker.filterBySeverity(report, ["HIGH"]);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].vulnerabilities).toHaveLength(1);
      expect(filtered[0].vulnerabilities[0].severity).toBe("HIGH");
    });

    it("excludes components with no matching vulnerabilities", () => {
      const report = {
        reportId: "r1",
        applicationId: "app1",
        scanId: "s1",
        scanTime: "2024-01-01",
        components: [
          {
            packageUrl: "pkg:maven/com.example/lib@1.0.0",
            displayName: "lib",
            version: "1.0.0",
            groupId: "com.example",
            artifactId: "lib",
            extension: "jar",
            vulnerabilities: [
              {
                id: "v1",
                referenceUrl: "",
                description: "low vuln",
                severity: "LOW" as const,
                cvssScore: 2.0,
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
        ],
        totalVulnerabilities: 1,
        vulnerabilitiesBySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1 },
      };

      const filtered = worker.filterBySeverity(report, ["HIGH", "CRITICAL"]);
      expect(filtered).toHaveLength(0);
    });
  });

  describe("getSuggestions", () => {
    it("extracts suggested versions from report", () => {
      const report = {
        reportId: "r1",
        applicationId: "app1",
        scanId: "s1",
        scanTime: "2024-01-01",
        components: [
          {
            packageUrl: "pkg:maven/com.example/lib@1.0.0",
            displayName: "lib",
            version: "1.0.0",
            groupId: "com.example",
            artifactId: "lib",
            extension: "jar",
            vulnerabilities: [
              {
                id: "v1",
                referenceUrl: "",
                description: "",
                severity: "HIGH" as const,
                cvssScore: 8.0,
                CWEs: [],
                licenseRisk: false,
                componentDisplayName: "lib",
                pathNames: [],
                suggestedVersion: "1.0.1",
                fixVersions: [],
                firstPublished: "",
                lastModified: "",
              },
            ],
          },
        ],
        totalVulnerabilities: 1,
        vulnerabilitiesBySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
      };

      const suggestions = worker.getSuggestions(report);
      expect(suggestions.get("pkg:maven/com.example/lib@1.0.0")).toBe("1.0.1");
    });

    it("returns empty map when no suggestions", () => {
      const report = {
        reportId: "r1",
        applicationId: "app1",
        scanId: "s1",
        scanTime: "2024-01-01",
        components: [],
        totalVulnerabilities: 0,
        vulnerabilitiesBySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      };

      const suggestions = worker.getSuggestions(report);
      expect(suggestions.size).toBe(0);
    });
  });

  describe("getVulnerabilitiesForComponent", () => {
    it("returns vulnerabilities for matching component", () => {
      const report = {
        reportId: "r1",
        applicationId: "app1",
        scanId: "s1",
        scanTime: "2024-01-01",
        components: [
          {
            packageUrl: "pkg:maven/com.example/lib@1.0.0",
            displayName: "lib",
            version: "1.0.0",
            groupId: "com.example",
            artifactId: "lib",
            extension: "jar",
            vulnerabilities: [
              {
                id: "v1",
                referenceUrl: "",
                description: "",
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
        ],
        totalVulnerabilities: 1,
        vulnerabilitiesBySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
      };

      const vulns = worker.getVulnerabilitiesForComponent(report, "com.example", "lib");
      expect(vulns).toHaveLength(1);
      expect(vulns[0].id).toBe("v1");
    });

    it("returns empty array for non-existent component", () => {
      const report = {
        reportId: "r1",
        applicationId: "app1",
        scanId: "s1",
        scanTime: "2024-01-01",
        components: [],
        totalVulnerabilities: 0,
        vulnerabilitiesBySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      };

      const vulns = worker.getVulnerabilitiesForComponent(report, "com.example", "missing");
      expect(vulns).toHaveLength(0);
    });
  });

  describe("getAllVulnerabilities", () => {
    it("deduplicates vulnerabilities across components", () => {
      const report = {
        reportId: "r1",
        applicationId: "app1",
        scanId: "s1",
        scanTime: "2024-01-01",
        components: [
          {
            packageUrl: "pkg:maven/com.example/lib-a@1.0.0",
            displayName: "lib-a",
            version: "1.0.0",
            groupId: "com.example",
            artifactId: "lib-a",
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
                componentDisplayName: "lib-a",
                pathNames: [],
                fixVersions: [],
                firstPublished: "",
                lastModified: "",
              },
            ],
          },
          {
            packageUrl: "pkg:maven/com.example/lib-b@2.0.0",
            displayName: "lib-b",
            version: "2.0.0",
            groupId: "com.example",
            artifactId: "lib-b",
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
                componentDisplayName: "lib-b",
                pathNames: [],
                fixVersions: [],
                firstPublished: "",
                lastModified: "",
              },
              {
                id: "CVE-2024-002",
                referenceUrl: "",
                description: "",
                severity: "MEDIUM" as const,
                cvssScore: 5.0,
                CWEs: [],
                licenseRisk: false,
                componentDisplayName: "lib-b",
                pathNames: [],
                fixVersions: [],
                firstPublished: "",
                lastModified: "",
              },
            ],
          },
        ],
        totalVulnerabilities: 3,
        vulnerabilitiesBySeverity: { CRITICAL: 0, HIGH: 2, MEDIUM: 1, LOW: 0 },
      };

      const vulns = worker.getAllVulnerabilities(report);
      expect(vulns).toHaveLength(2); // CVE-2024-001 deduplicated
      expect(vulns.map(v => v.id)).toContain("CVE-2024-001");
      expect(vulns.map(v => v.id)).toContain("CVE-2024-002");
    });
  });

  describe("checkConnectivity", () => {
    it("returns true when IQ is reachable", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ping: "ok" }));

      const result = await worker.checkConnectivity();
      expect(result).toBe(true);
    });

    it("returns false when IQ is unreachable", async () => {
      // Mock the private request method to bypass retry logic
      const requestSpy = vi.spyOn(worker as never, "request" as never);
      requestSpy.mockRejectedValueOnce(new Error("Connection refused") as never);

      const result = await worker.checkConnectivity();
      expect(result).toBe(false);

      requestSpy.mockRestore();
    });
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
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ applications: [] }),
      );

      await expect(worker.getApplication()).rejects.toThrow("Application not found");
    });
  });
});
