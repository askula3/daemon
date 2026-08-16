import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IQWorker } from "../workers/iq-worker.js";
import { MavenWorker } from "../workers/maven-worker.js";

/** Generate an ephemeral CycloneDX SBOM, submit it to IQ, and clean it up. */
export async function scanProjectWithIq(
  projectPath: string,
  mavenWorker: MavenWorker,
  iqWorker: IQWorker,
  timeoutMs: number,
  signal?: AbortSignal,
  includeRemediation: boolean = false,
) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "springbreaker-sbom-"));
  try {
    const bomPath = await mavenWorker.generateCycloneDxBom(
      projectPath,
      outputDirectory,
      timeoutMs,
      signal,
    );
    const cycloneDxJson = await readFile(bomPath, "utf-8");
    const report = await iqWorker.scanAndGetReport(cycloneDxJson, timeoutMs, signal);
    return includeRemediation
      ? await iqWorker.enrichReportWithRemediation(report, signal)
      : report;
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}
