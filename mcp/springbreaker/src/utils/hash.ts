import { createHash } from 'node:crypto';
import type { EnvConfig } from '../types/index.js';

/**
 * Compute SHA-256 hash of the given string content.
 * Used for project fingerprinting and policy hashing (spec §21).
 */
export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute a project fingerprint from key project state.
 * The fingerprint captures the POM content, modules, and dependency management
 * so that plan validation can detect if the project changed after planning.
 */
export function computeProjectFingerprint(
  rootPomContent: string,
  modules: string[],
  dependencyManagement: Array<{ groupId: string; artifactId: string; version: string }>,
  fingerprintFiles?: Record<string, string>,
): string {
  const canonical = JSON.stringify({
    pom: rootPomContent,
    files: fingerprintFiles
      ? Object.entries(fingerprintFiles).sort(([a], [b]) => a.localeCompare(b))
      : undefined,
    modules: [...modules].sort(),
    deps: dependencyManagement
      .map(d => `${d.groupId}:${d.artifactId}:${d.version}`)
      .sort(),
  });
  return sha256(canonical);
}

/**
 * Compute a policy hash from the serialized PolicyConfig.
 * Used to detect policy changes between plan creation and execution.
 */
export function computePolicyHash(policy: Record<string, unknown>): string {
  return sha256(JSON.stringify(policy));
}

/** Bind a plan to non-secret external-service identity and application scope. */
export function computeServiceConfigHash(
  config: Pick<EnvConfig, "iqServerUrl" | "iqAppId" | "nexusUrl">,
): string {
  return sha256(JSON.stringify({
    iqServerUrl: config.iqServerUrl,
    iqAppId: config.iqAppId,
    nexusUrl: config.nexusUrl,
  }));
}
