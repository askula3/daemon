import { createChildLogger } from "../utils/logger.js";
import { IQServerError } from "../utils/errors.js";
import { withRetry, isRetryableHttpStatus } from "../utils/retry.js";
import {
  fetchWithLimits,
  parseJsonBody,
  resolveSameOriginUrl,
  validateServiceUrl,
} from "../utils/http.js";
import type { IQReport, Component, Severity, Vulnerability } from "../types/index.js";
import { iqLimit } from "../utils/concurrency.js";

const log = createChildLogger("IQWorker");
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mapSeverity(value: unknown, score: number): Severity {
  if (typeof value === "string") {
    const normalized = value.toUpperCase();
    if (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(normalized)) return normalized as Severity;
  }
  if (score >= 9) return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MEDIUM";
  return "LOW";
}

function vulnerabilityFromIssue(issueValue: unknown, displayName: string, paths: string[]): Vulnerability {
  const issue = record(issueValue);
  const score = asNumber(issue.severity ?? issue.cvssScore);
  const reference = asString(issue.reference ?? issue.id);
  const url = asString(issue.url);
  return {
    id: reference || url || `unknown-${score}`,
    referenceUrl: url,
    description: asString(issue.threatCategory ?? issue.description),
    severity: mapSeverity(issue.severityLabel ?? issue.severity, score),
    cvssScore: score,
    CWEs: strings(issue.cwe ?? issue.CWEs),
    licenseRisk: false,
    componentDisplayName: displayName,
    pathNames: paths,
    suggestedVersion: asString(issue.suggestedVersion) || undefined,
    suggestedVersionUrl: asString(issue.suggestedVersionUrl) || undefined,
    fixVersions: strings(issue.fixVersions),
    firstPublished: asString(issue.firstPublished),
    lastModified: asString(issue.lastModified),
  };
}

export class IQWorker {
  private baseUrl: URL;
  private username: string;
  private token: string;
  private appId: string;

  constructor(
    baseUrl: string,
    token: string,
    appId: string,
    username: string = "admin",
    allowInsecureHttp: boolean = false,
  ) {
    this.baseUrl = validateServiceUrl(baseUrl, allowInsecureHttp);
    this.username = username;
    this.token = token;
    this.appId = appId;
  }

  private getAuthHeader(): string {
    return `Basic ${Buffer.from(`${this.username}:${this.token}`).toString("base64")}`;
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T>;
  private async request<T>(endpoint: string, options: RequestInit, emptyStatuses: number[]): Promise<T | null>;
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    emptyStatuses: number[] = [],
  ): Promise<T | null> {
    const url = resolveSameOriginUrl(this.baseUrl, endpoint);
    const headers = { Authorization: this.getAuthHeader(), Accept: "application/json", ...options.headers };
    log.debug(`IQ API request: ${options.method || "GET"} ${url}`);
    return withRetry(async () => {
      const { response, body } = await fetchWithLimits(url, { ...options, headers });
      if (emptyStatuses.includes(response.status)) return null;
      if (!response.ok) {
        const truncated = body.length > 500 ? `${body.slice(0, 500)}...` : body;
        const error = new IQServerError(
          `IQ API error: ${response.status} ${response.statusText} - ${truncated}`,
          "api-request",
        );
        (error as unknown as JsonRecord).status = response.status;
        throw error;
      }
      return parseJsonBody<T>(body, "IQ Server");
    }, {
      maxRetries: 3,
      baseDelayMs: 1_000,
      label: `IQ ${options.method || "GET"} ${url.pathname}`,
      signal: options.signal ?? undefined,
      isRetryable: (error) => {
        if (error instanceof IQServerError) {
          const status = (error as unknown as JsonRecord).status;
          if (typeof status === "number") return isRetryableHttpStatus(status);
        }
        return true;
      },
    });
  }

  async getApplication(signal?: AbortSignal): Promise<{ id: string; name: string; publicId: string }> {
    const response = await this.request<{ applications?: Array<{ id: string; name: string; publicId: string }> }>(
      `/api/v2/applications?publicId=${encodeURIComponent(this.appId)}`,
      { signal },
    );
    const app = response.applications?.find((candidate) => candidate.publicId === this.appId);
    if (!app?.id) throw new IQServerError(`Application not found: ${this.appId}`, "get-application");
    return app;
  }

  async triggerScan(cycloneDxJson: string, signal?: AbortSignal): Promise<{ applicationId: string; statusUrl: string }> {
    const app = await this.getApplication(signal);
    const response = await this.request<{ statusUrl?: string }>(
      `/api/v2/scan/applications/${encodeURIComponent(app.id)}/sources/cyclonedx`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: cycloneDxJson, signal },
    );
    if (!response.statusUrl) throw new IQServerError("IQ scan response omitted statusUrl", "trigger-scan");
    resolveSameOriginUrl(this.baseUrl, response.statusUrl);
    return { applicationId: app.id, statusUrl: response.statusUrl };
  }

  async waitForScan(
    statusUrl: string,
    timeoutMs: number = 300_000,
    pollIntervalMs: number = 5_000,
    signal?: AbortSignal,
  ): Promise<{ status: string; reportDataUrl: string }> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) throw new IQServerError("IQ scan cancelled", "wait-scan");
      const response = await this.request<{
        status?: string;
        reportDataUrl?: string;
        reportUrl?: string;
        errorMessage?: string;
        isError?: boolean;
      }>(statusUrl, { signal }, [404]);
      if (!response) {
        await this.waitForNextPoll(pollIntervalMs, signal);
        continue;
      }
      const status = (response.status ?? "").toUpperCase();
      const reportDataUrl = response.reportDataUrl ?? response.reportUrl;
      if (reportDataUrl || ["COMPLETED", "FINISHED", "SUCCESS"].includes(status)) {
        if (!reportDataUrl) throw new IQServerError("Completed IQ scan omitted reportDataUrl", "wait-scan");
        resolveSameOriginUrl(this.baseUrl, reportDataUrl);
        return { status: status || "COMPLETED", reportDataUrl };
      }
      if (response.isError || ["FAILED", "ERROR"].includes(status)) {
        throw new IQServerError(`IQ scan failed: ${response.errorMessage ?? status}`, "wait-scan");
      }
      await this.waitForNextPoll(pollIntervalMs, signal);
    }
    throw new IQServerError(`IQ scan timed out after ${timeoutMs}ms`, "wait-scan");
  }

  private async waitForNextPoll(pollIntervalMs: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => signal?.removeEventListener("abort", abort);
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, pollIntervalMs);
        const abort = (): void => {
          clearTimeout(timer);
          cleanup();
          reject(new IQServerError("IQ scan cancelled", "wait-scan"));
        };
        signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async getEvaluationReport(reportUrl: string, signal?: AbortSignal): Promise<IQReport> {
    const response = record(await this.request<unknown>(reportUrl, { signal }));
    if (!Array.isArray(response.components)) throw new IQServerError("IQ report omitted components", "parse-report");
    const components: Component[] = response.components.map((value) => {
      const component = record(value);
      const coordinates = record(record(component.componentIdentifier).coordinates);
      const groupId = asString(coordinates.groupId);
      const artifactId = asString(coordinates.artifactId);
      const version = asString(coordinates.version ?? component.version);
      if (!groupId || !artifactId || !version) {
        throw new IQServerError("IQ report contains invalid Maven coordinates", "parse-report");
      }
      const displayName = asString(component.displayName) || `${groupId}:${artifactId}:${version}`;
      const paths = strings(component.pathnames ?? component.pathNames);
      const securityData = record(component.securityData);
      const issues = Array.isArray(securityData.securityIssues)
        ? securityData.securityIssues
        : Array.isArray(component.violations) ? component.violations : [];
      return {
        packageUrl: asString(component.packageUrl) || `pkg:maven/${groupId}/${artifactId}@${version}`,
        displayName,
        version,
        groupId,
        artifactId,
        extension: asString(coordinates.extension) || "jar",
        vulnerabilities: issues.map((issue) => vulnerabilityFromIssue(issue, displayName, paths)),
      };
    }).filter((component) => component.vulnerabilities.length > 0);

    const vulnerabilitiesBySeverity: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    let totalVulnerabilities = 0;
    for (const component of components) {
      for (const issue of component.vulnerabilities) {
        vulnerabilitiesBySeverity[issue.severity]++;
        totalVulnerabilities++;
      }
    }
    const application = record(response.application);
    return {
      reportId: asString(response.reportId) || new URL(reportUrl, this.baseUrl).pathname.split("/").pop() || "",
      applicationId: asString(response.applicationId ?? application.publicId) || this.appId,
      scanId: asString(response.scanId),
      scanTime: asString(response.scanTime ?? response.reportTime),
      components,
      totalVulnerabilities,
      vulnerabilitiesBySeverity,
    };
  }

  private async getRemediationVersions(
    applicationInternalId: string,
    component: Component,
    scanId: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const params = new URLSearchParams({
      stageId: "build",
      identificationSource: "cyclonedx",
      scanId,
      includeParentRemediation: "true",
    });
    const response = record(await this.request<unknown>(
      `/api/v2/components/remediation/application/${encodeURIComponent(applicationInternalId)}?${params}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          componentIdentifier: {
            format: "maven",
            coordinates: {
              groupId: component.groupId,
              artifactId: component.artifactId,
              extension: component.extension,
              version: component.version,
            },
          },
        }),
        signal,
      },
    ));
    const remediation = record(response.remediation);
    const changes = Array.isArray(remediation.versionChanges) ? remediation.versionChanges : [];
    const preferredTypes = [
      "recommended-non-breaking-with-dependencies",
      "recommended-non-breaking",
      "next-no-violations-with-dependencies",
      "next-no-violations",
      "next-non-failing-with-dependencies",
      "next-non-failing",
    ];
    const ranked = changes
      .map((value) => record(value))
      .sort((left, right) => {
        const rank = (type: string): number => {
          const index = preferredTypes.indexOf(type);
          return index === -1 ? preferredTypes.length : index;
        };
        return rank(asString(left.type)) - rank(asString(right.type));
      });
    const versions = ranked.map((change) => {
      const data = record(change.data);
      const suggestedComponent = record(data.component);
      return asString(record(record(suggestedComponent.componentIdentifier).coordinates).version);
    }).filter(Boolean);
    return [...new Set(versions)];
  }

  async enrichReportWithRemediation(report: IQReport, signal?: AbortSignal): Promise<IQReport> {
    const application = await this.getApplication(signal);
    const scanId = report.scanId || report.reportId;
    const components = await Promise.all(report.components.map((component) => iqLimit(async () => {
      try {
        const versions = await this.getRemediationVersions(application.id, component, scanId, signal);
        if (versions.length === 0) return component;
        return {
          ...component,
          vulnerabilities: component.vulnerabilities.map((vulnerability) => ({
            ...vulnerability,
            suggestedVersion: versions[0],
            fixVersions: versions,
          })),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn(
          `IQ remediation lookup failed for ${component.groupId}:${component.artifactId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
        return component;
      }
    })));
    return { ...report, components };
  }

  async getLatestReport(signal?: AbortSignal): Promise<IQReport> {
    const app = await this.getApplication(signal);
    const response = await this.request<{ reports?: Array<{ reportDataUrl?: string; reportUrl?: string }> }>(
      `/api/v2/reports/applications/${encodeURIComponent(app.id)}`,
      { signal },
    );
    const latest = response.reports?.[0];
    const reportUrl = latest?.reportDataUrl ?? latest?.reportUrl;
    if (!reportUrl) throw new IQServerError("No reports found for application", "get-latest-report");
    return this.getEvaluationReport(reportUrl, signal);
  }

  async scanAndGetReport(
    cycloneDxJson: string,
    timeoutMs: number = 300_000,
    signal?: AbortSignal,
  ): Promise<IQReport> {
    const scan = await this.triggerScan(cycloneDxJson, signal);
    const completed = await this.waitForScan(scan.statusUrl, timeoutMs, 5_000, signal);
    return this.getEvaluationReport(completed.reportDataUrl, signal);
  }
}
