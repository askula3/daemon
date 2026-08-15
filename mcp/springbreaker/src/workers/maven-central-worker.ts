import { createChildLogger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
import {
  isSnapshot,
  isPreRelease,
  isRedHatBuild,
  parseVersion,
  compareVersions,
} from "../utils/semver.js";

const log = createChildLogger("MavenCentralWorker");

/**
 * Maven Central version resolver.
 *
 * Free, public, no-auth fallback when neither IQ Server nor Nexus Repository
 * is available. Uses the search.maven.org REST API to find latest stable
 * versions for dependency upgrades.
 *
 * API: https://search.maven.org/solrsearch/select?q=g:{groupId}+AND+a:{artifactId}&rows=200&wt=json
 */
export class MavenCentralWorker {
  private static readonly BASE_URL =
    "https://search.maven.org/solrsearch/select";

  // Make API request with retries
  private async request<T>(url: string): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(
            `Maven Central API error: ${response.status} ${response.statusText}`,
          );
        }

        return (await response.json()) as T;
      },
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        label: `Maven Central GET ${url}`,
      },
    );
  }

  /**
   * Get all versions of an artifact from Maven Central.
   */
  async getAllVersions(group: string, name: string): Promise<string[]> {
    const url =
      `${MavenCentralWorker.BASE_URL}?q=g:${encodeURIComponent(group)}+AND+a:${encodeURIComponent(name)}` +
      `&rows=200&wt=json`;

    try {
      const response = await this.request<{
        response: {
          numFound: number;
          docs: Array<{ v: string; latestVersion?: string }>;
        };
      }>(url);

      const versions = response.response.docs.map((d) => d.v).filter(Boolean);
      log.debug(
        `Maven Central found ${versions.length} versions for ${group}:${name}`,
      );
      return versions;
    } catch (error) {
      log.warn(`Maven Central search failed for ${group}:${name}: ${error}`);
      return [];
    }
  }

  /**
   * Suggest an upgrade for an artifact based on policy.
   * Returns the latest stable version that satisfies the upgrade policy,
   * or null if no suitable version is found.
   *
   * Compatible with NexusWorker.suggestUpgrade() signature.
   */
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
    } = {},
  ): Promise<{
    suggested: string | null;
    current: string;
    type: "patch" | "minor" | "major" | "none";
  }> {
    const versions = await this.getAllVersions(group, name);

    // Filter versions based on policy
    const validVersions = versions.filter((v) => {
      if (!options.allowSnapshots && isSnapshot(v)) return false;
      if (!options.allowPreRelease && isPreRelease(v)) return false;
      if (!options.allowRedHat && isRedHatBuild(v)) return false;
      return true;
    });

    // Sort descending (newest first)
    const sorted = [...validVersions].sort((a, b) => compareVersions(b, a));

    let suggested: string | null = null;
    let type: "patch" | "minor" | "major" | "none" = "none";

    for (const v of sorted) {
      // Skip if not newer
      if (compareVersions(v, currentVersion) <= 0) continue;

      const current = parseVersion(currentVersion);
      const target = parseVersion(v);
      if (!current || !target) continue;

      // Check upgrade type
      if (target.major > current.major) {
        if (!options.allowMajor) continue;
        type = "major";
      } else if (target.minor > current.minor) {
        if (!options.allowMinor) continue;
        type = "minor";
      } else {
        type = "patch";
      }

      suggested = v;
      break;
    }

    return { suggested, current: currentVersion, type };
  }
}
