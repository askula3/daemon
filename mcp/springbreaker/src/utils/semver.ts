// Semantic version comparison utilities

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  preRelease?: string;
  build?: string;
}

// Parse a version string into SemVer
export function parseVersion(version: string): SemVer | null {
  // Remove leading 'v' or 'V'
  const v = version.replace(/^[vV]/, '');

  // Match version pattern: major.minor.patch[-preRelease][+build]
  const match = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?(?:\+([a-zA-Z0-9.]+))?$/);

  if (!match) {
    return null;
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    preRelease: match[4],
    build: match[5],
  };
}

// Compare two versions
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const verA = parseVersion(a);
  const verB = parseVersion(b);

  if (!verA || !verB) {
    return a.localeCompare(b) as -1 | 0 | 1;
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

  // Compare pre-release
  if (verA.preRelease && !verB.preRelease) return -1;
  if (!verA.preRelease && verB.preRelease) return 1;
  if (verA.preRelease && verB.preRelease) {
    return verA.preRelease.localeCompare(verB.preRelease) as -1 | 0 | 1;
  }

  return 0;
}

// Check if version is newer than another
export function isNewer(version: string, than: string): boolean {
  return compareVersions(version, than) === 1;
}

// Check if version is a stable release (no pre-release tags)
export function isStableRelease(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return !parsed.preRelease;
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
    // If we can't parse versions, allow it with warning
    return { allowed: true };
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
