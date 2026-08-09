import { createChildLogger } from '../utils/logger.js';
import { IQServerError } from '../utils/errors.js';
import { withRetry, isRetryableHttpStatus } from '../utils/retry.js';
import type { IQReport, Component, Vulnerability, Severity } from '../types/index.js';

const log = createChildLogger('IQWorker');

export class IQWorker {
  private baseUrl: string;
  private username: string;
  private token: string;
  private appId: string;

  constructor(baseUrl: string, token: string, appId: string, username: string = 'admin') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.username = username;
    this.token = token;
    this.appId = appId;
  }

  // Get authorization header
  private getAuthHeader(): string {
    return `Basic ${Buffer.from(`${this.username}:${this.token}`).toString('base64')}`;
  }

  // Make API request with retries
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': this.getAuthHeader(),
      'Content-Type': 'application/json',
      ...options.headers,
    };

    log.debug(`IQ API request: ${options.method || 'GET'} ${url}`);

    return withRetry(
      async () => {
        const response = await fetch(url, {
          ...options,
          headers,
        });

        if (!response.ok) {
          const errorText = await response.text();
          const truncated = errorText.length > 500 ? errorText.slice(0, 500) + '...' : errorText;
          const err = new IQServerError(
            `IQ API error: ${response.status} ${response.statusText} - ${truncated}`,
            'api-request',
          );
          // Attach status for retry classification
          (err as unknown as Record<string, unknown>).status = response.status;
          throw err;
        }

        return await response.json() as T;
      },
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        label: `IQ ${options.method || 'GET'} ${endpoint}`,
        isRetryable: (error) => {
          if (error instanceof IQServerError) {
            const status = (error as unknown as Record<string, unknown>).status;
            if (typeof status === 'number') return isRetryableHttpStatus(status);
          }
          // Connection errors are retryable
          return true;
        },
      },
    );
  }

  // Check IQ Server connectivity
  async checkConnectivity(): Promise<boolean> {
    try {
      await this.request('/api/v2/system/ping');
      return true;
    } catch {
      return false;
    }
  }

  // Get application info
  async getApplication(): Promise<{
    id: string;
    name: string;
    publicId: string;
  }> {
    const response = await this.request<{ applications: Array<{
      id: string;
      name: string;
      publicId: string;
    }> }>(`/api/v2/applications?publicId=${this.appId}`);

    const app = response.applications?.find(a => a.publicId === this.appId);
    if (!app) {
      throw new IQServerError(`Application not found: ${this.appId}`, 'get-application');
    }

    return app;
  }

  // Trigger policy evaluation scan
  async triggerScan(
    projectId: string,
    scanType: 'source' | 'binary' = 'source'
  ): Promise<string> {
    const endpoint = `/api/v2/scan/applications/${this.appId}`;

    log.info(`Triggering IQ scan for application: ${this.appId}`);

    const response = await this.request<{ scanId: string }>(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        scanType,
        projectId,
      }),
    });

    log.info(`Scan triggered: ${response.scanId}`);
    return response.scanId;
  }

  // Wait for scan to complete
  async waitForScan(
    scanId: string,
    timeoutMs: number = 300000,  // 5 minutes
    pollIntervalMs: number = 5000
  ): Promise<{ status: string; reportUrl?: string }> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const response = await this.request<{
        status: string;
        reportUrl?: string;
      }>(`/api/v2/scan/status/${scanId}`);

      log.debug(`Scan status: ${response.status}`);

      if (response.status === 'finished' || response.status === 'completed') {
        return response;
      }

      if (response.status === 'failed' || response.status === 'error') {
        throw new IQServerError(`Scan failed: ${response.status}`, 'wait-scan');
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new IQServerError('Scan timed out', 'wait-scan');
  }

  // Get evaluation report
  async getEvaluationReport(
    reportUrl: string
  ): Promise<IQReport> {
    log.info(`Fetching evaluation report: ${reportUrl}`);

    const response = await this.request<{
      applicationId: string;
      scanId: string;
      scanTime: string;
      components: Array<{
        packageUrl: string;
        displayName: string;
        version: string;
        componentIdentifier: {
          coordinates: {
            groupId: string;
            artifactId: string;
            version: string;
            extension: string;
          };
        };
        violations: Array<{
          violationId: string;
          referenceUrl: string;
          description: string;
          severity: string;
          cvssScore: number;
          CWEs: string[];
          licenseRisk: boolean;
          componentDisplayName: string;
          pathNames: string[];
          suggestedVersion?: string;
          suggestedVersionUrl?: string;
          fixVersions: string[];
          firstPublished: string;
          lastModified: string;
        }>;
      }>;
    }>(reportUrl);

    // Transform to our format
    const components: Component[] = response.components.map(comp => ({
      packageUrl: comp.packageUrl,
      displayName: comp.displayName,
      version: comp.version,
      groupId: comp.componentIdentifier?.coordinates?.groupId || '',
      artifactId: comp.componentIdentifier?.coordinates?.artifactId || '',
      extension: comp.componentIdentifier?.coordinates?.extension || 'jar',
      vulnerabilities: comp.violations.map(v => ({
        id: v.violationId,
        referenceUrl: v.referenceUrl,
        description: v.description,
        severity: v.severity as Severity,
        cvssScore: v.cvssScore,
        CWEs: v.CWEs || [],
        licenseRisk: v.licenseRisk,
        componentDisplayName: v.componentDisplayName,
        pathNames: v.pathNames || [],
        suggestedVersion: v.suggestedVersion,
        suggestedVersionUrl: v.suggestedVersionUrl,
        fixVersions: v.fixVersions || [],
        firstPublished: v.firstPublished,
        lastModified: v.lastModified,
      })),
    }));

    // Count vulnerabilities by severity
    const vulnerabilitiesBySeverity: Record<Severity, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };

    let totalVulnerabilities = 0;
    for (const comp of components) {
      for (const vuln of comp.vulnerabilities) {
        vulnerabilitiesBySeverity[vuln.severity]++;
        totalVulnerabilities++;
      }
    }

    return {
      reportId: reportUrl.split('/').pop() || '',
      applicationId: response.applicationId,
      scanId: response.scanId,
      scanTime: response.scanTime,
      components,
      totalVulnerabilities,
      vulnerabilitiesBySeverity,
    };
  }

  // Get latest report for application
  async getLatestReport(): Promise<IQReport> {
    const response = await this.request<{
      reports: Array<{
        reportUrl: string;
        scanId: string;
        scanTime: string;
      }>;
    }>(`/api/v2/reports/evaluation/${this.appId}`);

    if (!response.reports || response.reports.length === 0) {
      throw new IQServerError('No reports found for application', 'get-latest-report');
    }

    const latestReport = response.reports[0];
    return this.getEvaluationReport(latestReport.reportUrl);
  }

  // Scan and get report (convenience method)
  async scanAndGetReport(
    projectId: string,
    timeoutMs: number = 300000
  ): Promise<IQReport> {
    const scanId = await this.triggerScan(projectId);
    const scanResult = await this.waitForScan(scanId, timeoutMs);

    if (scanResult.reportUrl) {
      return this.getEvaluationReport(scanResult.reportUrl);
    }

    // If no report URL, try to get latest
    return this.getLatestReport();
  }

  // Filter vulnerabilities by severity
  filterBySeverity(
    report: IQReport,
    severities: Severity[]
  ): Component[] {
    return report.components
      .map(comp => ({
        ...comp,
        vulnerabilities: comp.vulnerabilities.filter(
          v => severities.includes(v.severity)
        ),
      }))
      .filter(comp => comp.vulnerabilities.length > 0);
  }

  // Get component suggestions
  getSuggestions(report: IQReport): Map<string, string> {
    const suggestions = new Map<string, string>();

    for (const comp of report.components) {
      for (const vuln of comp.vulnerabilities) {
        if (vuln.suggestedVersion) {
          suggestions.set(comp.packageUrl, vuln.suggestedVersion);
        }
      }
    }

    return suggestions;
  }

  // Get vulnerabilities for a specific component
  getVulnerabilitiesForComponent(
    report: IQReport,
    groupId: string,
    artifactId: string
  ): Vulnerability[] {
    const comp = report.components.find(
      c => c.groupId === groupId && c.artifactId === artifactId
    );
    return comp?.vulnerabilities || [];
  }

  // Get all unique vulnerabilities
  getAllVulnerabilities(report: IQReport): Vulnerability[] {
    const seen = new Set<string>();
    const vulns: Vulnerability[] = [];

    for (const comp of report.components) {
      for (const vuln of comp.vulnerabilities) {
        if (!seen.has(vuln.id)) {
          seen.add(vuln.id);
          vulns.push(vuln);
        }
      }
    }

    return vulns;
  }
}
