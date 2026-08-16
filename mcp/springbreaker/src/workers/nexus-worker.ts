import { createChildLogger } from "../utils/logger.js";
import { NexusError } from "../utils/errors.js";
import { withRetry, isRetryableHttpStatus } from "../utils/retry.js";
import { fetchWithLimits, parseJsonBody, resolveSameOriginUrl, validateServiceUrl } from "../utils/http.js";
import type { NexusArtifact } from "../types/index.js";
import {
  isSnapshot,
  isPreRelease,
  isRedHatBuild,
  parseVersion,
  compareVersions,
} from "../utils/semver.js";

const log = createChildLogger("NexusWorker");

export class NexusWorker {
  private baseUrl: URL;
  private username: string;
  private password: string;

  constructor(baseUrl: string, username: string, password: string, allowInsecureHttp: boolean = false) {
    this.baseUrl = validateServiceUrl(baseUrl, allowInsecureHttp);
    this.username = username;
    this.password = password;
  }

  // Get authorization header
  private getAuthHeader(): string {
    return `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
  }

  // Make API request with retries
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = resolveSameOriginUrl(this.baseUrl, endpoint);
    const headers = {
      Authorization: this.getAuthHeader(),
      Accept: "application/json",
      ...options.headers,
    };

    log.debug(`Nexus API request: ${options.method || "GET"} ${url}`);

    return withRetry(
      async () => {
        const { response, body } = await fetchWithLimits(url, {
          ...options,
          headers,
        });

        if (!response.ok) {
          const truncated = body.length > 500 ? body.slice(0, 500) + "..." : body;
          const err = new NexusError(
            `Nexus API error: ${response.status} ${response.statusText} - ${truncated}`,
            "api-request",
          );
          (err as unknown as Record<string, unknown>).status = response.status;
          throw err;
        }

        return parseJsonBody<T>(body, "Nexus Repository");
      },
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        label: `Nexus ${options.method || "GET"} ${endpoint}`,
        signal: options.signal ?? undefined,
        isRetryable: (error) => {
          if (error instanceof NexusError) {
            const status = (error as unknown as Record<string, unknown>).status;
            if (typeof status === "number")
              return isRetryableHttpStatus(status);
          }
          return true;
        },
      },
    );
  }

  // Search for artifacts
  async search(
    group: string,
    name: string,
    options: {
      version?: string;
      repository?: string;
      format?: string;
      sort?: "version" | "name" | "group";
      direction?: "asc" | "desc";
      signal?: AbortSignal;
    } = {},
  ): Promise<NexusArtifact[]> {
    const params = new URLSearchParams();
    params.append("group", group);
    params.append("name", name);

    if (options.version) params.append("version", options.version);
    if (options.repository) params.append("repository", options.repository);
    if (options.format) params.append("format", options.format);
    if (options.sort) params.append("sort", options.sort);
    if (options.direction) params.append("direction", options.direction);

    const results: NexusArtifact[] = [];
    let continuationToken: string | undefined;
    let pageCount = 0;
    do {
      const pageParams = new URLSearchParams(params);
      if (continuationToken) pageParams.set("continuationToken", continuationToken);
      const response = await this.request<{
      items: Array<{
        group: string;
        name: string;
        version: string;
        repository: string;
        format: string;
        assets: Array<{
          mimeType: string;
          downloadUrl: string;
          path: string;
          checksums: Record<string, string>;
          lastModified: string;
          lastUploaded: string;
          extraFields: Record<string, unknown>;
        }>;
        assetsByAssetVersion: Record<string, unknown[]>;
      }>;
      continuationToken?: string | null;
      }>(`/service/rest/v1/search?${pageParams.toString()}`, { signal: options.signal });

      results.push(...response.items.map((item) => ({
        group: item.group,
        name: item.name,
        version: item.version,
        repository: item.repository,
        format: item.format,
        packaging: item.assets?.[0]?.mimeType || "jar",
        timestamp: item.assets?.[0]?.lastUploaded || "",
        classifiers: [],
      })));
      continuationToken = response.continuationToken ?? undefined;
      pageCount++;
      if (pageCount >= 50 && continuationToken) {
        throw new NexusError("Nexus search exceeded 50 pages", "search-pagination");
      }
    } while (continuationToken);

    return results;
  }

  // Search for a specific version
  async searchVersion(
    group: string,
    name: string,
    version: string,
    repository?: string,
    signal?: AbortSignal,
  ): Promise<NexusArtifact | null> {
    const results = await this.search(group, name, { version, repository, signal });
    return results.length > 0 ? results[0] : null;
  }

  // Get all versions of an artifact
  async getAllVersions(
    group: string,
    name: string,
    repository?: string,
    signal?: AbortSignal,
  ): Promise<NexusArtifact[]> {
    return this.search(group, name, {
      repository,
      sort: "version",
      direction: "desc",
      signal,
    });
  }

  // Get latest stable version (no snapshots, pre-release, etc.)
  async getLatestStableVersion(
    group: string,
    name: string,
    options: {
      allowSnapshots?: boolean;
      allowPreRelease?: boolean;
      allowRedHat?: boolean;
      repository?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<NexusArtifact | null> {
    const versions = await this.getAllVersions(group, name, options.repository, options.signal);

    // Filter versions based on policy
    const stableVersions = versions.filter((v) => {
      if (!options.allowSnapshots && isSnapshot(v.version)) return false;
      if (!options.allowPreRelease && isPreRelease(v.version)) return false;
      if (!options.allowRedHat && isRedHatBuild(v.version)) return false;
      return true;
    });

    return stableVersions.length > 0 ? stableVersions[0] : null;
  }

  // Compare versions and suggest upgrade
  async suggestUpgrade(
    group: string,
    name: string,
    currentVersion: string,
    options: {
      allowMinor?: boolean;
      allowMajor?: boolean;
      allowPatch?: boolean;
      allowSnapshots?: boolean;
      allowPreRelease?: boolean;
      allowRedHat?: boolean;
      repository?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<{
    suggested: string | null;
    current: string;
    type: "patch" | "minor" | "major" | "none";
  }> {
    const versions = await this.getAllVersions(group, name, options.repository, options.signal);

    // Filter versions based on policy
    const validVersions = versions.filter((v) => {
      if (!options.allowSnapshots && isSnapshot(v.version)) return false;
      if (!options.allowPreRelease && isPreRelease(v.version)) return false;
      if (!options.allowRedHat && isRedHatBuild(v.version)) return false;
      return true;
    });

    // Find the latest version that is newer than current
    let suggested: string | null = null;
    let type: "patch" | "minor" | "major" | "none" = "none";

    for (const v of validVersions) {
      // Skip if not newer
      if (compareVersions(v.version, currentVersion) <= 0) continue;

      const current = parseVersion(currentVersion);
      const target = parseVersion(v.version);
      if (!current || !target) continue;

      // Check upgrade type
      if (target.major > current.major) {
        if (!options.allowMajor) continue;
        type = "major";
      } else if (target.minor > current.minor) {
        if (!options.allowMinor) continue;
        type = "minor";
      } else {
        if (options.allowPatch === false) continue;
        type = "patch";
      }

      suggested = v.version;
      break;
    }

    return {
      suggested,
      current: currentVersion,
      type,
    };
  }
}
