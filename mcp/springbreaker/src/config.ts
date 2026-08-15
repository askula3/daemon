import { parse as dotenvParse } from "dotenv";
import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createChildLogger } from "./utils/logger.js";
import type { EnvConfig, PolicyConfig, Severity } from "./types/index.js";

const log = createChildLogger("Config");

// Default policy configuration
export const DEFAULT_POLICY: PolicyConfig = {
  severity: ["HIGH", "MEDIUM"],
  preferParentUpgrade: true,
  preferOwningDependency: true,
  preferIqSuggestion: true,
  removeUnused: true,
  allowPatch: true,
  allowMinor: true,
  allowMajor: false,
  allowSnapshots: false,
  allowRedhat: false,
  verifyBuild: true,
  verifyIq: true,
  maxBatchSize: 10,
  timeout: 300000, // 5 minutes
};

// Parse severity from environment variable
function parseSeverities(value: string | undefined): Severity[] {
  if (!value) return DEFAULT_POLICY.severity;
  const validSeverities: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  return value
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is Severity => validSeverities.includes(s as Severity));
}

/**
 * Read and parse a .env file from the given project path.
 * Returns an empty object if the file doesn't exist or can't be parsed.
 * This is the SINGLE source of .env parsing — avoids reading the file twice.
 */
function readEnvFile(projectPath?: string): Record<string, string> {
  const envPath = projectPath
    ? resolve(projectPath, ".env")
    : resolve(process.cwd(), ".env");

  if (!existsSync(envPath)) return {};

  try {
    const content = readFileSync(envPath, "utf-8");
    return dotenvParse(content);
  } catch {
    return {};
  }
}

/**
 * Resolve a config value: file env takes priority, then process.env.
 * This prevents cross-project contamination in a long-running MCP server
 * because we never mutate process.env with project-specific .env values.
 */
function resolveEnv(
  key: string,
  fileEnv: Record<string, string>,
): string | undefined {
  return fileEnv[key] ?? process.env[key];
}

// Load environment configuration
export function loadEnvConfig(projectPath?: string): EnvConfig {
  const fileEnv = readEnvFile(projectPath);
  const get = (key: string) => resolveEnv(key, fileEnv);

  return {
    iqServerUrl: get("IQ_SERVER_URL") || "http://localhost:8070",
    iqServerToken: get("IQ_SERVER_TOKEN") || "",
    iqAppId: get("IQ_APP_ID") || "",
    iqUsername: get("IQ_USERNAME") || "admin",
    nexusUrl: get("NEXUS_URL") || "http://localhost:8081",
    nexusUsername: get("NEXUS_USERNAME") || "",
    nexusPassword: get("NEXUS_PASSWORD") || "",
    preferMvnw: get("PREFER_MVNW") !== "false",
    mavenOpts: get("MAVEN_OPTS"),
    logLevel: get("LOG_LEVEL") || "info",
  };
}

// Load policy configuration from project or use defaults
export function loadPolicyConfig(projectPath?: string): PolicyConfig {
  const policyPath = projectPath
    ? join(projectPath, ".remediation-policy.json")
    : undefined;

  let filePolicy: Partial<PolicyConfig> = {};

  if (policyPath && existsSync(policyPath)) {
    try {
      const content = readFileSync(policyPath, "utf-8");
      filePolicy = JSON.parse(content);
    } catch (error) {
      log.warn(`Failed to parse policy file ${policyPath}: ${error}`);
    }
  }

  // Read .env once and reuse for all env lookups
  const fileEnv = readEnvFile(projectPath);
  const get = (key: string) => resolveEnv(key, fileEnv);

  // Merge with environment overrides
  return {
    ...DEFAULT_POLICY,
    ...filePolicy,
    severity: get("DEFAULT_SEVERITY")
      ? parseSeverities(get("DEFAULT_SEVERITY"))
      : filePolicy.severity || DEFAULT_POLICY.severity,
    allowMinor: get("ALLOW_MINOR_UPGRADES")
      ? get("ALLOW_MINOR_UPGRADES") === "true"
      : (filePolicy.allowMinor ?? DEFAULT_POLICY.allowMinor),
    allowMajor: get("ALLOW_MAJOR_UPGRADES")
      ? get("ALLOW_MAJOR_UPGRADES") === "true"
      : (filePolicy.allowMajor ?? DEFAULT_POLICY.allowMajor),
    allowSnapshots: get("ALLOW_SNAPSHOTS")
      ? get("ALLOW_SNAPSHOTS") === "true"
      : (filePolicy.allowSnapshots ?? DEFAULT_POLICY.allowSnapshots),
    allowRedhat: get("ALLOW_REDHAT")
      ? get("ALLOW_REDHAT") === "true"
      : (filePolicy.allowRedhat ?? DEFAULT_POLICY.allowRedhat),
  };
}

/**
 * Validate environment configuration and return advisory warnings.
 *
 * Only IQ_SERVER_TOKEN and IQ_APP_ID are truly required for vulnerability
 * scanning. Nexus is optional — the server falls back to Maven Central
 * for version resolution when Nexus is not configured.
 *
 * Returns warnings (not hard errors) so the server works in Nexus-less
 * and IQ-less environments where only dependency-tree analysis is useful.
 */
export function validateEnvConfig(config: EnvConfig): string[] {
  const warnings: string[] = [];

  if (!config.iqServerToken || !config.iqAppId) {
    warnings.push(
      "IQ Server not configured (IQ_SERVER_TOKEN / IQ_APP_ID missing) — vulnerability scanning disabled. " +
        "Set these to enable IQ-based vulnerability detection.",
    );
  }
  if (!config.nexusUsername) {
    warnings.push(
      "Nexus Repository not configured (NEXUS_USERNAME missing) — falling back to Maven Central for version resolution.",
    );
  }

  return warnings;
}
