import { createChildLogger } from '../utils/logger.js';
import { NexusError } from '../utils/errors.js';
import { withRetry, isRetryableHttpStatus } from '../utils/retry.js';
import { nexusLimit } from '../utils/concurrency.js';
import type { NexusArtifact } from '../types/index.js';
import { isSnapshot, isPreRelease, isRedHatBuild, parseVersion, compareVersions } from '../utils/semver.js';

const log = createChildLogger('NexusWorker');

export class NexusWorker {
  private baseUrl: string;
  private username: string;
  private password: string;

  constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
  }

  // Get authorization header
  private getAuthHeader(): string {
    return `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
  }

  // Make API request with retries
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': this.getAuthHeader(),
      'Accept': 'application/json',
      ...options.headers,
    };

    log.debug(`Nexus API request: ${options.method || 'GET'} ${url}`);

    return withRetry(
      async () => {
        const response = await fetch(url, {
          ...options,
          headers,
        });

        if (!response.ok) {
          const errorText = await response.text();
          const truncated = errorText.length > 500 ? errorText.slice(0, 500) + '...' : errorText;
          const err = new NexusError(
            `Nexus API error: ${response.status} ${response.statusText} - ${truncated}`,
            'api-request',
          );
          (err as unknown as Record<string, unknown>).status = response.status;
          throw err;
        }

        return await response.json() as T;
      },
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        label: `Nexus ${options.method || 'GET'} ${endpoint}`,
        isRetryable: (error) => {
          if (error instanceof NexusError) {
            const status = (error as unknown as Record<string, unknown>).status;
            if (typeof status === 'number') return isRetryableHttpStatus(status);
          }
          return true;
        },
      },
    );
  }

  // Check Nexus connectivity
  async checkConnectivity(): Promise<boolean> {
    try {
      await this.request('/service/rest/v1/status');
      return true;
    } catch {
      return false;
    }
  }

  // Search for artifacts
  async search(
    group: string,
    name: string,
    options: {
      version?: string;
      repository?: string;
      format?: string;
      sort?: 'version' | 'name' | 'group';
      direction?: 'asc' | 'desc';
    } = {}
  ): Promise<NexusArtifact[]> {
    const params = new URLSearchParams();
    params.append('group', group);
    params.append('name', name);

    if (options.version) params.append('version', options.version);
    if (options.repository) params.append('repository', options.repository);
    if (options.format) params.append('format', options.format);
    if (options.sort) params.append('sort', options.sort);
    if (options.direction) params.append('direction', options.direction);

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
    }>(`/service/rest/v1/search?${params.toString()}`);

    return response.items.map(item => ({
      group: item.group,
      name: item.name,
      version: item.version,
      repository: item.repository,
      format: item.format,
      packaging: item.assets?.[0]?.mimeType || 'jar',
      timestamp: item.assets?.[0]?.lastUploaded || '',
      classifiers: [],
    }));
  }

  // Search for a specific version
  async searchVersion(
    group: string,
    name: string,
    version: string,
    repository?: string
  ): Promise<NexusArtifact | null> {
    const results = await this.search(group, name, { version, repository });
    return results.length > 0 ? results[0] : null;
  }

  // Get all versions of an artifact
  async getAllVersions(
    group: string,
    name: string,
    repository?: string
  ): Promise<NexusArtifact[]> {
    return this.search(group, name, {
      repository,
      sort: 'version',
      direction: 'desc',
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
    } = {}
  ): Promise<NexusArtifact | null> {
    const versions = await this.getAllVersions(group, name, options.repository);

    // Filter versions based on policy
    const stableVersions = versions.filter(v => {
      if (!options.allowSnapshots && isSnapshot(v.version)) return false;
      if (!options.allowPreRelease && isPreRelease(v.version)) return false;
      if (!options.allowRedHat && isRedHatBuild(v.version)) return false;
      return true;
    });

    return stableVersions.length > 0 ? stableVersions[0] : null;
  }

  // Get latest version (any)
  async getLatestVersion(
    group: string,
    name: string,
    repository?: string
  ): Promise<NexusArtifact | null> {
    const versions = await this.getAllVersions(group, name, repository);
    return versions.length > 0 ? versions[0] : null;
  }

  // Check if a version exists
  async versionExists(
    group: string,
    name: string,
    version: string,
    repository?: string
  ): Promise<boolean> {
    const result = await this.searchVersion(group, name, version, repository);
    return result !== null;
  }

  // Get download URL for an artifact
  async getDownloadUrl(
    group: string,
    name: string,
    version: string,
    options: {
      repository?: string;
      extension?: string;
      classifier?: string;
    } = {}
  ): Promise<string | null> {
    const params = new URLSearchParams();
    params.append('group', group);
    params.append('name', name);
    params.append('version', version);

    if (options.repository) params.append('repository', options.repository);
    if (options.extension) params.append('maven.extension', options.extension);
    if (options.classifier) params.append('maven.classifier', options.classifier);

    const response = await this.request<{
      items: Array<{
        assets: Array<{
          downloadUrl: string;
        }>;
      }>;
    }>(`/service/rest/v1/search/assets?${params.toString()}`);

    if (response.items.length > 0 && response.items[0].assets.length > 0) {
      return response.items[0].assets[0].downloadUrl;
    }

    return null;
  }

  // Get component metadata
  async getComponentMetadata(
    group: string,
    name: string,
    version: string
  ): Promise<{
    groupId: string;
    artifactId: string;
    version: string;
    packaging: string;
    timestamp: string;
    description?: string;
    homepage?: string;
  } | null> {
    const artifact = await this.searchVersion(group, name, version);

    if (!artifact) return null;

    return {
      groupId: artifact.group,
      artifactId: artifact.name,
      version: artifact.version,
      packaging: artifact.packaging,
      timestamp: artifact.timestamp,
    };
  }

  // Compare versions and suggest upgrade
  async suggestUpgrade(
    group: string,
    name: string,
    currentVersion: string,
    options: {
      allowMinor?: boolean;
      allowMajor?: boolean;
      allowSnapshots?: boolean;
      allowPreRelease?: boolean;
      allowRedHat?: boolean;
      repository?: string;
    } = {}
  ): Promise<{
    suggested: string | null;
    current: string;
    type: 'patch' | 'minor' | 'major' | 'none';
  }> {
    const versions = await this.getAllVersions(group, name, options.repository);

    // Filter versions based on policy
    const validVersions = versions.filter(v => {
      if (!options.allowSnapshots && isSnapshot(v.version)) return false;
      if (!options.allowPreRelease && isPreRelease(v.version)) return false;
      if (!options.allowRedHat && isRedHatBuild(v.version)) return false;
      return true;
    });

    // Find the latest version that is newer than current
    let suggested: string | null = null;
    let type: 'patch' | 'minor' | 'major' | 'none' = 'none';

    for (const v of validVersions) {
      // Skip if not newer
      if (compareVersions(v.version, currentVersion) <= 0) continue;

      const current = parseVersion(currentVersion);
      const target = parseVersion(v.version);
      if (!current || !target) continue;

      // Check upgrade type
      if (target.major > current.major) {
        if (!options.allowMajor) continue;
        type = 'major';
      } else if (target.minor > current.minor) {
        if (!options.allowMinor) continue;
        type = 'minor';
      } else {
        type = 'patch';
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

  // Batch search for multiple artifacts — uses shared nexusLimit for
  // consistent concurrency control across the codebase.
  async batchSearch(
    artifacts: Array<{ group: string; name: string }>,
    options: {
      allowSnapshots?: boolean;
      allowPreRelease?: boolean;
      allowRedHat?: boolean;
      repository?: string;
    } = {}
  ): Promise<Map<string, NexusArtifact | null>> {
    const results = new Map<string, NexusArtifact | null>();

    const tasks = artifacts.map(artifact =>
      nexusLimit(async () => {
        const key = `${artifact.group}:${artifact.name}`;
        try {
          const result = await this.getLatestStableVersion(
            artifact.group,
            artifact.name,
            options
          );
          results.set(key, result);
        } catch (error) {
          log.warn(`Failed to search for ${key}: ${error}`);
          results.set(key, null);
        }
      })
    );

    await Promise.all(tasks);
    return results;
  }
}
