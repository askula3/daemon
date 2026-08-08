import { describe, it, expect } from 'vitest';
import {
  parseVersion,
  compareVersions,
  isNewer,
  isStableRelease,
  isSnapshot,
  isPreRelease,
  isRedHatBuild,
  isUpgradeAllowed,
  getUpgradeType,
} from '../../src/utils/semver.js';

describe('semver', () => {
  describe('parseVersion', () => {
    it('should parse valid version', () => {
      const result = parseVersion('1.2.3');
      expect(result).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    it('should parse version with v prefix', () => {
      const result = parseVersion('v1.2.3');
      expect(result).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    it('should parse version with pre-release', () => {
      const result = parseVersion('1.2.3-alpha.1');
      expect(result).toEqual({ major: 1, minor: 2, patch: 3, preRelease: 'alpha.1' });
    });

    it('should parse version with build metadata', () => {
      const result = parseVersion('1.2.3+build.123');
      expect(result).toEqual({ major: 1, minor: 2, patch: 3, build: 'build.123' });
    });

    it('should return null for invalid version', () => {
      const result = parseVersion('invalid');
      expect(result).toBeNull();
    });
  });

  describe('compareVersions', () => {
    it('should return -1 when a < b', () => {
      expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
      expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
      expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    });

    it('should return 0 when a === b', () => {
      expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    });

    it('should return 1 when a > b', () => {
      expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
      expect(compareVersions('1.1.0', '1.0.0')).toBe(1);
      expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    });
  });

  describe('isNewer', () => {
    it('should return true when version is newer', () => {
      expect(isNewer('2.0.0', '1.0.0')).toBe(true);
      expect(isNewer('1.1.0', '1.0.0')).toBe(true);
      expect(isNewer('1.0.1', '1.0.0')).toBe(true);
    });

    it('should return false when version is not newer', () => {
      expect(isNewer('1.0.0', '2.0.0')).toBe(false);
      expect(isNewer('1.0.0', '1.1.0')).toBe(false);
      expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    });
  });

  describe('isStableRelease', () => {
    it('should return true for stable releases', () => {
      expect(isStableRelease('1.0.0')).toBe(true);
      expect(isStableRelease('2.3.4')).toBe(true);
    });

    it('should return false for pre-releases', () => {
      expect(isStableRelease('1.0.0-alpha.1')).toBe(false);
      expect(isStableRelease('1.0.0-beta.1')).toBe(false);
      expect(isStableRelease('1.0.0-rc.1')).toBe(false);
    });
  });

  describe('isSnapshot', () => {
    it('should return true for snapshots', () => {
      expect(isSnapshot('1.0.0-SNAPSHOT')).toBe(true);
      expect(isSnapshot('1.0.0.snapshot')).toBe(true);
      expect(isSnapshot('1.0.0-SNAPSHOT-20240101')).toBe(true);
    });

    it('should return false for non-snapshots', () => {
      expect(isSnapshot('1.0.0')).toBe(false);
      expect(isSnapshot('1.0.0-alpha.1')).toBe(false);
    });
  });

  describe('isPreRelease', () => {
    it('should return true for pre-releases', () => {
      expect(isPreRelease('1.0.0-alpha.1')).toBe(true);
      expect(isPreRelease('1.0.0-beta.1')).toBe(true);
      expect(isPreRelease('1.0.0-rc.1')).toBe(true);
      expect(isPreRelease('1.0.0-m1')).toBe(true);
      expect(isPreRelease('1.0.0-cr1')).toBe(true);
    });

    it('should return false for stable releases', () => {
      expect(isPreRelease('1.0.0')).toBe(false);
      expect(isPreRelease('1.0.0-SNAPSHOT')).toBe(false);
    });
  });

  describe('isRedHatBuild', () => {
    it('should return true for Red Hat builds', () => {
      expect(isRedHatBuild('1.0.0-redhat-001')).toBe(true);
      expect(isRedHatBuild('1.0.0.redhat')).toBe(true);
      expect(isRedHatBuild('1.0.0-amzn-1')).toBe(true);
    });

    it('should return false for non-Red Hat builds', () => {
      expect(isRedHatBuild('1.0.0')).toBe(false);
      expect(isRedHatBuild('1.0.0-alpha.1')).toBe(false);
    });
  });

  describe('isUpgradeAllowed', () => {
    const policy = {
      allowPatch: true,
      allowMinor: true,
      allowMajor: false,
      allowSnapshots: false,
      allowRedhat: false,
    };

    it('should allow patch upgrades', () => {
      const result = isUpgradeAllowed('1.0.0', '1.0.1', policy);
      expect(result.allowed).toBe(true);
    });

    it('should allow minor upgrades', () => {
      const result = isUpgradeAllowed('1.0.0', '1.1.0', policy);
      expect(result.allowed).toBe(true);
    });

    it('should reject major upgrades when not allowed', () => {
      const result = isUpgradeAllowed('1.0.0', '2.0.0', policy);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Major upgrade not allowed');
    });

    it('should allow major upgrades when allowed', () => {
      const result = isUpgradeAllowed('1.0.0', '2.0.0', { ...policy, allowMajor: true });
      expect(result.allowed).toBe(true);
    });

    it('should reject snapshots when not allowed', () => {
      const result = isUpgradeAllowed('1.0.0', '1.0.1-SNAPSHOT', policy);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Snapshots not allowed');
    });

    it('should reject Red Hat builds when not allowed', () => {
      const result = isUpgradeAllowed('1.0.0', '1.0.1-redhat-001', policy);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Red Hat builds not allowed');
    });
  });

  describe('getUpgradeType', () => {
    it('should return patch for patch upgrades', () => {
      expect(getUpgradeType('1.0.0', '1.0.1')).toBe('patch');
    });

    it('should return minor for minor upgrades', () => {
      expect(getUpgradeType('1.0.0', '1.1.0')).toBe('minor');
    });

    it('should return major for major upgrades', () => {
      expect(getUpgradeType('1.0.0', '2.0.0')).toBe('major');
    });

    it('should return same for same versions', () => {
      expect(getUpgradeType('1.0.0', '1.0.0')).toBe('same');
    });
  });
});
