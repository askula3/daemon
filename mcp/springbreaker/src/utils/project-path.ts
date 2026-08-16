import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { ValidationError } from "./errors.js";
import { resolveTrustedServerEnv } from "../config.js";

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(resolve(path));
  } catch {
    throw new ValidationError(`${label} does not exist or cannot be resolved: ${path}`);
  }

  const pathStat = await stat(canonicalPath);
  if (!pathStat.isDirectory()) {
    throw new ValidationError(`${label} must be a directory: ${path}`);
  }
  return canonicalPath;
}

/**
 * Resolve a caller-supplied project path to its canonical directory. When
 * SPRINGBREAKER_ALLOWED_ROOTS is set, projects must be contained by one of the
 * configured roots. Canonicalization prevents symlink and path-alias lock bypasses.
 */
export async function resolveProjectPath(projectPath: string): Promise<string> {
  if (!projectPath.trim()) {
    throw new ValidationError("projectPath must not be empty");
  }

  const canonicalProject = await canonicalDirectory(projectPath, "projectPath");
  const allowedRoots = (resolveTrustedServerEnv("SPRINGBREAKER_ALLOWED_ROOTS") ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (allowedRoots.length === 0) return canonicalProject;

  const canonicalRoots = await Promise.all(
    allowedRoots.map((root) => canonicalDirectory(root, "Allowed project root")),
  );
  if (!canonicalRoots.some((root) => isWithin(root, canonicalProject))) {
    throw new ValidationError(
      `projectPath is outside SPRINGBREAKER_ALLOWED_ROOTS: ${projectPath}`,
    );
  }

  return canonicalProject;
}

/** Resolve a path and verify that it cannot escape the canonical project root. */
export async function assertPathWithinProject(
  projectRoot: string,
  candidatePath: string,
): Promise<string> {
  const canonicalRoot = await canonicalDirectory(projectRoot, "Project root");
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(resolve(candidatePath));
  } catch {
    throw new ValidationError(`Project path does not exist: ${candidatePath}`);
  }

  if (!isWithin(canonicalRoot, canonicalCandidate)) {
    throw new ValidationError(`Path escapes project root: ${candidatePath}`);
  }
  return canonicalCandidate;
}
