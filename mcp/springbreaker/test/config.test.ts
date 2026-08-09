import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadEnvConfig,
  loadPolicyConfig,
  validateEnvConfig,
  DEFAULT_POLICY,
} from "../src/config.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "config-test-" + Date.now());

describe("config", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("loadEnvConfig", () => {
    it("uses defaults when no .env exists", () => {
      const config = loadEnvConfig(TEST_DIR);
      expect(config.iqServerUrl).toBe("http://localhost:8070");
      expect(config.nexusUrl).toBe("http://localhost:8081");
      expect(config.preferMvnw).toBe(true);
    });

    it("reads values from .env file", async () => {
      await writeFile(
        join(TEST_DIR, ".env"),
        "IQ_SERVER_URL=https://iq.example.com\nNEXUS_USERNAME=admin\n",
        "utf-8",
      );
      const config = loadEnvConfig(TEST_DIR);
      expect(config.iqServerUrl).toBe("https://iq.example.com");
      expect(config.nexusUsername).toBe("admin");
    });

    it("file env takes priority over process.env", async () => {
      const origEnv = process.env.IQ_SERVER_URL;
      process.env.IQ_SERVER_URL = "https://from-env.example.com";

      await writeFile(
        join(TEST_DIR, ".env"),
        "IQ_SERVER_URL=https://from-file.example.com\n",
        "utf-8",
      );
      const config = loadEnvConfig(TEST_DIR);
      expect(config.iqServerUrl).toBe("https://from-file.example.com");

      // Restore
      if (origEnv !== undefined) process.env.IQ_SERVER_URL = origEnv;
      else delete process.env.IQ_SERVER_URL;
    });

    it("falls back to process.env when .env has no value", () => {
      const config = loadEnvConfig(TEST_DIR);
      // process.env LOG_LEVEL should be used if not in .env
      expect(config.logLevel).toBeDefined();
    });
  });

  describe("loadPolicyConfig", () => {
    it("returns default policy when no policy file exists", () => {
      const policy = loadPolicyConfig(TEST_DIR);
      expect(policy.severity).toEqual(DEFAULT_POLICY.severity);
      expect(policy.allowMajor).toBe(false);
      expect(policy.verifyBuild).toBe(true);
    });

    it("loads policy from .remediation-policy.json", async () => {
      const policyFile = join(TEST_DIR, ".remediation-policy.json");
      await writeFile(
        policyFile,
        JSON.stringify({
          severity: ["CRITICAL"],
          allowMajor: true,
        }),
        "utf-8",
      );

      const policy = loadPolicyConfig(TEST_DIR);
      expect(policy.severity).toEqual(["CRITICAL"]);
      expect(policy.allowMajor).toBe(true);
      // Defaults preserved for unset fields
      expect(policy.verifyBuild).toBe(true);
    });

    it("env overrides file policy for severity", async () => {
      const origEnv = process.env.DEFAULT_SEVERITY;
      process.env.DEFAULT_SEVERITY = "CRITICAL,HIGH";

      const policy = loadPolicyConfig(TEST_DIR);
      expect(policy.severity).toEqual(["CRITICAL", "HIGH"]);

      if (origEnv !== undefined) process.env.DEFAULT_SEVERITY = origEnv;
      else delete process.env.DEFAULT_SEVERITY;
    });
  });

  describe("validateEnvConfig", () => {
    it("returns errors for missing required vars", () => {
      const errors = validateEnvConfig({
        iqServerUrl: "",
        iqServerToken: "",
        iqAppId: "",
        iqUsername: "admin",
        nexusUrl: "",
        nexusUsername: "",
        nexusPassword: "",
        preferMvnw: true,
        logLevel: "info",
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes("IQ_SERVER_TOKEN"))).toBe(true);
      expect(errors.some((e) => e.includes("IQ_APP_ID"))).toBe(true);
      expect(errors.some((e) => e.includes("NEXUS_USERNAME"))).toBe(true);
    });

    it("returns no errors when all required vars are set", () => {
      const errors = validateEnvConfig({
        iqServerUrl: "http://localhost:8070",
        iqServerToken: "token",
        iqAppId: "app-id",
        iqUsername: "admin",
        nexusUrl: "http://localhost:8081",
        nexusUsername: "admin",
        nexusPassword: "pass",
        preferMvnw: true,
        logLevel: "info",
      });
      expect(errors).toEqual([]);
    });
  });
});
