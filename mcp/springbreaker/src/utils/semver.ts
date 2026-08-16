// Semantic version comparison utilities

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  preRelease?: string;
  build?: string;
}

function stableQualifier(qualifier: string | undefined): boolean {
  return qualifier === undefined || /^(?:final|ga|release)$/i.test(qualifier);
}

function compareQualifier(a: string | undefined, b: string | undefined): -1 | 0 | 1 {
  if (stableQualifier(a) && stableQualifier(b)) return 0;
  if (stableQualifier(a)) return b?.toLowerCase().startsWith("sp") ? -1 : 1;
  if (stableQualifier(b)) return a?.toLowerCase().startsWith("sp") ? 1 : -1;

  const tokenize = (value: string): Array<string | number> =>
    value.toLowerCase().split(/[.-]/).flatMap((part) => {
      const pieces = part.match(/\d+|\D+/g) ?? [];
      return pieces.map((piece) => /^\d+$/.test(piece) ? Number(piece) : piece);
    });
  const aliases: Record<string, number> = {
    alpha: -5, a: -5, beta: -4, b: -4, milestone: -3, m: -3,
    rc: -2, cr: -2, snapshot: -1, sp: 1,
  };
  const left = tokenize(a ?? "");
  const right = tokenize(b ?? "");
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === rightPart) continue;
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (typeof leftPart === "number" && typeof rightPart === "number") {
      return leftPart < rightPart ? -1 : 1;
    }
    const leftRank = typeof leftPart === "string" ? (aliases[leftPart] ?? -1) : leftPart;
    const rightRank = typeof rightPart === "string" ? (aliases[rightPart] ?? -1) : rightPart;
    if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
    const lexical = String(leftPart).localeCompare(String(rightPart));
    if (lexical !== 0) return lexical < 0 ? -1 : 1;
  }
  return 0;
}

// Parse a version string into SemVer
export function parseVersion(version: string): SemVer | null {
  // Remove leading 'v' or 'V'
  const v = version.trim().replace(/^[vV]/, '');

  // Maven commonly uses one, two, or three numeric release segments. Keep
  // qualifiers explicit and reject properties, ranges, and dynamic versions.
  const match = v.match(
    /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.]([a-zA-Z0-9][a-zA-Z0-9.-]*))?(?:\+([a-zA-Z0-9.-]+))?$/,
  );

  if (!match) {
    return null;
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2] ?? "0", 10),
    patch: parseInt(match[3] ?? "0", 10),
    preRelease: match[4],
    build: match[5],
  };
}

// Compare two versions
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const verA = parseVersion(a);
  const verB = parseVersion(b);

  if (!verA || !verB) {
    if (a === b) return 0;
    return a.localeCompare(b) < 0 ? -1 : 1;
  }

  // Compare major
  if (verA.major !== verB.major) {
    return verA.major < verB.major ? -1 : 1;
  }

  // Compare minor
  if (verA.minor !== verB.minor) {
    return verA.minor < verB.minor ? -1 : 1;
  }

  // Compare patch
  if (verA.patch !== verB.patch) {
    return verA.patch < verB.patch ? -1 : 1;
  }

  return compareQualifier(verA.preRelease, verB.preRelease);
}

// Check if version is newer than another
export function isNewer(version: string, than: string): boolean {
  return compareVersions(version, than) === 1;
}

// Check if version is a stable release (no pre-release tags)
export function isStableRelease(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return stableQualifier(parsed.preRelease);
}

// Check if version is a snapshot
export function isSnapshot(version: string): boolean {
  return version.toLowerCase().includes('snapshot');
}

// Check if version is a pre-release (alpha, beta, rc, milestone, etc.)
export function isPreRelease(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed || !parsed.preRelease) return false;

  const preReleaseLower = parsed.preRelease.toLowerCase();
  return (
    preReleaseLower.startsWith('alpha') ||
    preReleaseLower.startsWith('beta') ||
    preReleaseLower.startsWith('rc') ||
    preReleaseLower.startsWith('milestone') ||
    preReleaseLower.startsWith('m1') ||
    preReleaseLower.startsWith('m2') ||
    preReleaseLower.startsWith('m3') ||
    preReleaseLower.startsWith('m4') ||
    preReleaseLower.startsWith('m5') ||
    preReleaseLower.startsWith('m6') ||
    preReleaseLower.startsWith('m7') ||
    preReleaseLower.startsWith('m8') ||
    preReleaseLower.startsWith('m9') ||
    preReleaseLower.startsWith('cr')    // candidate release
  );
}

// Check if version is a Red Hat / custom vendor build
export function isRedHatBuild(version: string): boolean {
  const lower = version.toLowerCase();
  return (
    lower.includes('redhat') ||
    lower.includes('red-hat') ||
    lower.includes('amzn') ||
    lower.includes('amzn2')
  );
}

// Check if an upgrade is allowed based on policy
export function isUpgradeAllowed(
  currentVersion: string,
  targetVersion: string,
  policy: {
    allowPatch: boolean;
    allowMinor: boolean;
    allowMajor: boolean;
    allowSnapshots: boolean;
    allowRedhat: boolean;
  }
): { allowed: boolean; reason?: string } {
  // Check for snapshots
  if (!policy.allowSnapshots && isSnapshot(targetVersion)) {
    return { allowed: false, reason: 'Snapshots not allowed' };
  }

  // Check for pre-release
  if (isPreRelease(targetVersion)) {
    return { allowed: false, reason: 'Pre-release versions not allowed' };
  }

  // Check for Red Hat builds
  if (!policy.allowRedhat && isRedHatBuild(targetVersion)) {
    return { allowed: false, reason: 'Red Hat builds not allowed' };
  }

  const current = parseVersion(currentVersion);
  const target = parseVersion(targetVersion);

  if (!current || !target) {
    return { allowed: false, reason: 'Version cannot be parsed safely' };
  }

  // Check upgrade type
  if (target.major > current.major) {
    return policy.allowMajor
      ? { allowed: true }
      : { allowed: false, reason: 'Major upgrade not allowed' };
  }

  if (target.minor > current.minor) {
    return policy.allowMinor
      ? { allowed: true }
      : { allowed: false, reason: 'Minor upgrade not allowed' };
  }

  if (target.patch > current.patch) {
    return policy.allowPatch
      ? { allowed: true }
      : { allowed: false, reason: 'Patch upgrade not allowed' };
  }

  // Same or downgrade - check if it's a valid upgrade
  if (compareVersions(targetVersion, currentVersion) <= 0) {
    return { allowed: false, reason: 'Target version is not newer' };
  }

  return { allowed: true };
}

// Get upgrade type description
export function getUpgradeType(currentVersion: string, targetVersion: string): string {
  const current = parseVersion(currentVersion);
  const target = parseVersion(targetVersion);

  if (!current || !target) return 'unknown';

  if (target.major > current.major) return 'major';
  if (target.minor > current.minor) return 'minor';
  if (target.patch > current.patch) return 'patch';
  if (compareVersions(targetVersion, currentVersion) > 0) return 'prerelease';
  return 'same';
}
