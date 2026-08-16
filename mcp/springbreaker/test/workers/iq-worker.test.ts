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
      "https://iq-server.example.test",
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

  it("executes the documented third-party SBOM scan contract", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        applications: [{ id: "internal-app", name: "App", publicId: "test-app" }],
      }))
      .mockResolvedValueOnce(jsonResponse({ statusUrl: "api/v2/scan/applications/internal-app/status/s1" }))
      .mockResolvedValueOnce(jsonResponse({
        reportDataUrl: "api/v2/applications/test-app/reports/report-1/raw",
        isError: false,
      }))
      .mockResolvedValueOnce(jsonResponse({
        reportId: "report-1",
        scanId: "scan-1",
        components: [{
          packageUrl: "pkg:maven/org.example/library@1.0.0?type=jar",
          displayName: "org.example : library : 1.0.0",
          componentIdentifier: {
            format: "maven",
            coordinates: {
              groupId: "org.example",
              artifactId: "library",
              extension: "jar",
              version: "1.0.0",
            },
          },
          pathnames: ["org.example:app:jar:1.0.0/org.example:library:jar:1.0.0"],
          securityData: {
            securityIssues: [{
              reference: "CVE-2026-0001",
              severity: 8.1,
              url: "https://example.test/CVE-2026-0001",
              threatCategory: "severe",
            }],
          },
        }],
      }));

    const report = await worker.scanAndGetReport('{"bomFormat":"CycloneDX"}', 1_000);

    expect(report.reportId).toBe("report-1");
    expect(report.totalVulnerabilities).toBe(1);
    expect(report.components[0].vulnerabilities[0]).toMatchObject({
      id: "CVE-2026-0001",
      cvssScore: 8.1,
      severity: "HIGH",
    });
    expect(String(mockFetch.mock.calls[1][0])).toContain(
      "/api/v2/scan/applications/internal-app/sources/cyclonedx",
    );
    expect(mockFetch.mock.calls[1][1]).toMatchObject({ method: "POST", redirect: "manual" });
  });

  it("treats a 404 status response as not ready", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ message: "not ready" }, 404))
      .mockResolvedValueOnce(jsonResponse({ reportDataUrl: "/api/v2/reports/ready/raw" }));

    const result = await worker.waitForScan("/api/v2/status/scan", 1_000, 1);
    expect(result).toEqual({
      status: "COMPLETED",
      reportDataUrl: "/api/v2/reports/ready/raw",
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects cross-origin URLs returned by IQ", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        applications: [{ id: "internal-app", name: "App", publicId: "test-app" }],
      }))
      .mockResolvedValueOnce(jsonResponse({ statusUrl: "https://evil.test/status" }));

    await expect(worker.triggerScan("{}"))
      .rejects.toThrow("cross-origin service URL");
  });

  it("enriches vulnerabilities from the official remediation API", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        applications: [{ id: "internal-app", name: "App", publicId: "test-app" }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        remediation: {
          versionChanges: [
            {
              type: "next-non-failing",
              data: { component: { componentIdentifier: { coordinates: { version: "1.1.0" } } } },
            },
            {
              type: "recommended-non-breaking-with-dependencies",
              data: { component: { componentIdentifier: { coordinates: { version: "1.0.2" } } } },
            },
          ],
        },
      }));
    const report = {
      reportId: "report-1",
      applicationId: "test-app",
      scanId: "scan-1",
      scanTime: "",
      totalVulnerabilities: 1,
      vulnerabilitiesBySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
      components: [{
        packageUrl: "pkg:maven/org.example/library@1.0.0",
        displayName: "org.example:library:1.0.0",
        version: "1.0.0",
        groupId: "org.example",
        artifactId: "library",
        extension: "jar",
        vulnerabilities: [{
          id: "CVE-1", referenceUrl: "", description: "", severity: "HIGH" as const,
          cvssScore: 8, CWEs: [], licenseRisk: false, componentDisplayName: "library",
          pathNames: [], fixVersions: [], firstPublished: "", lastModified: "",
        }],
      }],
    };

    const enriched = await worker.enrichReportWithRemediation(report);
    expect(enriched.components[0].vulnerabilities[0]).toMatchObject({
      suggestedVersion: "1.0.2",
      fixVersions: ["1.0.2", "1.1.0"],
    });
    const remediationUrl = new URL(String(mockFetch.mock.calls[1][0]));
    expect(remediationUrl.pathname).toBe("/api/v2/components/remediation/application/internal-app");
    expect(remediationUrl.searchParams.get("scanId")).toBe("scan-1");
    expect(remediationUrl.searchParams.get("identificationSource")).toBe("cyclonedx");
  });
});
