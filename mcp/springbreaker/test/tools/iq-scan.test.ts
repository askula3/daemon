import { afterEach, describe, expect, it, vi } from "vitest";
import { access, writeFile } from "node:fs/promises";
import { scanProjectWithIq } from "../../src/tools/iq-scan.js";
import type { IQReport } from "../../src/types/index.js";
import type { IQWorker } from "../../src/workers/iq-worker.js";
import type { MavenWorker } from "../../src/workers/maven-worker.js";

const generatedDirectories: string[] = [];
const emptyReport: IQReport = {
  reportId: "report",
  applicationId: "app",
  scanId: "scan",
  scanTime: "",
  components: [],
  totalVulnerabilities: 0,
  vulnerabilitiesBySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
};

afterEach(() => {
  generatedDirectories.length = 0;
});

describe("ephemeral IQ scanning", () => {
  it("generates, submits, enriches, and always deletes the temporary SBOM", async () => {
    const mavenWorker = {
      generateCycloneDxBom: vi.fn(async (_projectPath: string, outputDirectory: string) => {
        generatedDirectories.push(outputDirectory);
        const path = `${outputDirectory}/springbreaker-bom.json`;
        await writeFile(path, '{"bomFormat":"CycloneDX"}', "utf-8");
        return path;
      }),
    } as unknown as MavenWorker;
    const scanAndGetReport = vi.fn().mockResolvedValue(emptyReport);
    const iqWorker = {
      scanAndGetReport,
      enrichReportWithRemediation: vi.fn().mockResolvedValue({ ...emptyReport, reportId: "enriched" }),
    } as unknown as IQWorker;

    const report = await scanProjectWithIq("/project", mavenWorker, iqWorker, 1_000, undefined, true);
    expect(report.reportId).toBe("enriched");
    expect(scanAndGetReport).toHaveBeenCalledWith(
      '{"bomFormat":"CycloneDX"}', 1_000, undefined,
    );
    await expect(access(generatedDirectories[0])).rejects.toThrow();
  });

  it("cleans the temporary directory when IQ rejects the scan", async () => {
    const mavenWorker = {
      generateCycloneDxBom: vi.fn(async (_projectPath: string, outputDirectory: string) => {
        generatedDirectories.push(outputDirectory);
        const path = `${outputDirectory}/springbreaker-bom.json`;
        await writeFile(path, "{}", "utf-8");
        return path;
      }),
    } as unknown as MavenWorker;
    const iqWorker = {
      scanAndGetReport: vi.fn().mockRejectedValue(new Error("IQ unavailable")),
    } as unknown as IQWorker;

    await expect(scanProjectWithIq("/project", mavenWorker, iqWorker, 1_000))
      .rejects.toThrow("IQ unavailable");
    await expect(access(generatedDirectories[0])).rejects.toThrow();
  });
});
