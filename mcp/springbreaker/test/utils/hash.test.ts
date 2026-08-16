import { describe, it, expect } from "vitest";
import {
  sha256,
  computeProjectFingerprint,
  computePolicyHash,
  computeServiceConfigHash,
} from "../../src/utils/hash.js";

describe("hash utilities", () => {
  describe("sha256", () => {
    it("returns a 64-char hex string", () => {
      const hash = sha256("hello");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic", () => {
      expect(sha256("test")).toBe(sha256("test"));
    });

    it("produces different hashes for different inputs", () => {
      expect(sha256("a")).not.toBe(sha256("b"));
    });
  });

  describe("computeProjectFingerprint", () => {
    it("is deterministic for same inputs", () => {
      const fp1 = computeProjectFingerprint(
        "<pom/>",
        ["mod-a"],
        [{ groupId: "g", artifactId: "a", version: "1" }],
      );
      const fp2 = computeProjectFingerprint(
        "<pom/>",
        ["mod-a"],
        [{ groupId: "g", artifactId: "a", version: "1" }],
      );
      expect(fp1).toBe(fp2);
    });

    it("changes when POM content changes", () => {
      const fp1 = computeProjectFingerprint("<pom>v1</pom>", [], []);
      const fp2 = computeProjectFingerprint("<pom>v2</pom>", [], []);
      expect(fp1).not.toBe(fp2);
    });

    it("changes when modules change", () => {
      const fp1 = computeProjectFingerprint("<pom/>", ["mod-a"], []);
      const fp2 = computeProjectFingerprint("<pom/>", ["mod-b"], []);
      expect(fp1).not.toBe(fp2);
    });

    it("is order-independent for modules and deps", () => {
      const fp1 = computeProjectFingerprint("<pom/>", ["mod-b", "mod-a"], []);
      const fp2 = computeProjectFingerprint("<pom/>", ["mod-a", "mod-b"], []);
      expect(fp1).toBe(fp2);
    });
  });

  describe("computePolicyHash", () => {
    it("is deterministic", () => {
      const h1 = computePolicyHash({ severity: ["HIGH"], allowMajor: false });
      const h2 = computePolicyHash({ severity: ["HIGH"], allowMajor: false });
      expect(h1).toBe(h2);
    });

    it("changes when policy changes", () => {
      const h1 = computePolicyHash({ severity: ["HIGH"] });
      const h2 = computePolicyHash({ severity: ["LOW"] });
      expect(h1).not.toBe(h2);
    });
  });

  describe("computeServiceConfigHash", () => {
    const config = {
      iqServerUrl: "https://iq.example.test",
      iqAppId: "public-app",
      nexusUrl: "https://nexus.example.test",
    };

    it("is deterministic but changes with application or endpoint scope", () => {
      expect(computeServiceConfigHash(config)).toBe(computeServiceConfigHash(config));
      expect(computeServiceConfigHash(config)).not.toBe(
        computeServiceConfigHash({ ...config, iqAppId: "another-app" }),
      );
    });
  });
});
