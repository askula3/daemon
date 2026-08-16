import { parse as dotenvParse } from "dotenv";
import { dirname, resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EnvConfig, PolicyConfig, Severity } from "./types/index.js";
import { ConfigurationError } from "./utils/errors.js";

// Stable in both src/config.ts and dist/config.js. Never derive the trusted
// server configuration location from process.cwd(), which is commonly the
// untrusted target project for stdio MCP launches.
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  maxReplans: 3,
  maxBatches: 10,
  maxMavenFailures: 3,
  maxModifications: 50,
};

// Parse severity from environment variable
function parseSeverities(value: string | undefined): Severity[] {
  if (!value) return DEFAULT_POLICY.severity;
  const validSeverities: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const severities = value
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is Severity => validSeverities.includes(s as Severity));
  if (severities.length === 0) {
    throw new ConfigurationError(
      `DEFAULT_SEVERITY must contain at least one of: ${validSeverities.join(", ")}`,
    );
  }
  return severities;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigurationError(`Expected boolean value "true" or "false", got: ${value}`);
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseLogLevel(value: string | undefined): EnvConfig["logLevel"] {
  const level = (value ?? "info").toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(level)) {
    throw new ConfigurationError("LOG_LEVEL must be one of: debug, info, warn, error");
  }
  return level as EnvConfig["logLevel"];
}

function parseMavenEnvAllowlist(value: string | undefined): string[] {
  const keys = parseList(value);
  const sensitive = new Set(["IQ_SERVER_TOKEN", "NEXUS_PASSWORD"]);
  const forbidden = keys.filter((key) => sensitive.has(key));
  if (forbidden.length > 0) {
    throw new ConfigurationError(
      `MAVEN_ENV_ALLOWLIST must not expose service secrets: ${forbidden.join(", ")}`,
    );
  }
  return keys;
}

/**
 * Read and parse a .env file from the given project path.
 * Returns an empty object if the file doesn't exist. Existing configuration
 * files must remain readable and parseable; silently ignoring one can make a
 * remediation run use different credentials or policy than the operator
 * intended.
 * This is the SINGLE source of .env parsing — avoids reading the file twice.
 */
function readEnvFile(projectPath?: string): Record<string, string> {
  const envPath = projectPath
    ? resolve(projectPath, ".env")
    : join(SERVER_ROOT, ".env");

  if (!existsSync(envPath)) return {};

  try {
    const content = readFileSync(envPath, "utf-8");
    return dotenvParse(content);
  } catch (error) {
    throw new ConfigurationError(`Failed to read environment file ${envPath}: ${error}`);
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

/** Read a value only from the MCP process or the package-local server .env. */
export function resolveTrustedServerEnv(key: string): string | undefined {
  return process.env[key] ?? readEnvFile()[key];
}

export function validatePolicyConfig(policy: PolicyConfig): PolicyConfig {
  const allowedSeverities: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  if (
    !Array.isArray(policy.severity) ||
    policy.severity.length === 0 ||
    policy.severity.some((severity) => !allowedSeverities.includes(severity))
  ) {
    throw new ConfigurationError("Policy severity must be a non-empty list of valid severities");
  }

  const booleans: (keyof PolicyConfig)[] = [
    "preferParentUpgrade", "preferOwningDependency", "preferIqSuggestion",
    "removeUnused", "allowPatch", "allowMinor", "allowMajor", "allowSnapshots",
    "allowRedhat", "verifyBuild", "verifyIq",
  ];
  for (const key of booleans) {
    if (typeof policy[key] !== "boolean") {
      throw new ConfigurationError(`Policy ${key} must be a boolean`);
    }
  }

  const positiveIntegers: (keyof PolicyConfig)[] = [
    "maxBatchSize", "maxReplans", "maxBatches", "maxMavenFailures", "maxModifications",
  ];
  for (const key of positiveIntegers) {
    const value = policy[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new ConfigurationError(`Policy ${key} must be a positive integer`);
    }
  }
  if (typeof policy.timeout !== "number" || !Number.isFinite(policy.timeout) || policy.timeout <= 0) {
    throw new ConfigurationError("Policy timeout must be a positive number");
  }
  return policy;
}

// Load environment configuration
export function loadEnvConfig(projectPath?: string): EnvConfig {
  const serverEnv = readEnvFile();
  const projectEnv = projectPath ? readEnvFile(projectPath) : {};
  const trusted = (key: string): string | undefined => process.env[key] ?? serverEnv[key];
  const project = (key: string): string | undefined => projectEnv[key] ?? trusted(key);
  const allowProjectServices = parseBoolean(
    trusted("ALLOW_PROJECT_SERVICE_CONFIG"),
    false,
  );
  const projectHasIqBundle = ["IQ_SERVER_URL", "IQ_SERVER_TOKEN", "IQ_APP_ID"]
    .every((key) => Boolean(projectEnv[key]));
  const projectHasNexusBundle = ["NEXUS_URL", "NEXUS_USERNAME", "NEXUS_PASSWORD"]
    .every((key) => Boolean(projectEnv[key]));
  const iq = (key: string): string | undefined =>
    allowProjectServices && projectHasIqBundle ? projectEnv[key] : trusted(key);
  const nexus = (key: string): string | undefined =>
    allowProjectServices && projectHasNexusBundle ? projectEnv[key] : trusted(key);

  return {
    iqServerUrl: iq("IQ_SERVER_URL") || "http://localhost:8070",
    iqServerToken: iq("IQ_SERVER_TOKEN") || "",
    iqAppId: iq("IQ_APP_ID") || "",
    iqUsername: iq("IQ_USERNAME") || "admin",
    nexusUrl: nexus("NEXUS_URL") || "http://localhost:8081",
    nexusUsername: nexus("NEXUS_USERNAME") || "",
    nexusPassword: nexus("NEXUS_PASSWORD") || "",
    preferMvnw: parseBoolean(project("PREFER_MVNW"), true),
    mavenOpts: trusted("MAVEN_OPTS"),
    logLevel: parseLogLevel(trusted("LOG_LEVEL")),
    mavenEnvAllowlist: parseMavenEnvAllowlist(trusted("MAVEN_ENV_ALLOWLIST")),
    allowInsecureHttp: parseBoolean(trusted("ALLOW_INSECURE_HTTP"), false),
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
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("policy must be a JSON object");
      }
      filePolicy = parsed;
    } catch (error) {
      throw new ConfigurationError(`Failed to parse policy file ${policyPath}: ${error}`);
    }
  }

  // Read .env once and reuse for all env lookups
  const fileEnv = readEnvFile(projectPath);
  const get = (key: string) => resolveEnv(key, fileEnv);

  // Merge with environment overrides
  return validatePolicyConfig({
    ...DEFAULT_POLICY,
    ...filePolicy,
    severity: get("DEFAULT_SEVERITY")
      ? parseSeverities(get("DEFAULT_SEVERITY"))
      : filePolicy.severity || DEFAULT_POLICY.severity,
    allowMinor: parseBoolean(get("ALLOW_MINOR_UPGRADES"), filePolicy.allowMinor ?? DEFAULT_POLICY.allowMinor),
    allowMajor: parseBoolean(get("ALLOW_MAJOR_UPGRADES"), filePolicy.allowMajor ?? DEFAULT_POLICY.allowMajor),
    allowSnapshots: parseBoolean(get("ALLOW_SNAPSHOTS"), filePolicy.allowSnapshots ?? DEFAULT_POLICY.allowSnapshots),
    allowRedhat: parseBoolean(get("ALLOW_REDHAT"), filePolicy.allowRedhat ?? DEFAULT_POLICY.allowRedhat),
  });
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
