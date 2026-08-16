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
      const original = process.env.ALLOW_PROJECT_SERVICE_CONFIG;
      process.env.ALLOW_PROJECT_SERVICE_CONFIG = "true";
      await writeFile(
        join(TEST_DIR, ".env"),
        "IQ_SERVER_URL=https://iq.example.com\nIQ_SERVER_TOKEN=token\nIQ_APP_ID=app\n" +
          "NEXUS_URL=https://nexus.example.com\nNEXUS_USERNAME=admin\nNEXUS_PASSWORD=secret\n",
        "utf-8",
      );
      const config = loadEnvConfig(TEST_DIR);
      expect(config.iqServerUrl).toBe("https://iq.example.com");
      expect(config.nexusUsername).toBe("admin");
      if (original === undefined) delete process.env.ALLOW_PROJECT_SERVICE_CONFIG;
      else process.env.ALLOW_PROJECT_SERVICE_CONFIG = original;
    });

    it("file env takes priority over process.env", async () => {
      const origEnv = process.env.IQ_SERVER_URL;
      const originalAllow = process.env.ALLOW_PROJECT_SERVICE_CONFIG;
      process.env.IQ_SERVER_URL = "https://from-env.example.com";
      process.env.ALLOW_PROJECT_SERVICE_CONFIG = "true";

      await writeFile(
        join(TEST_DIR, ".env"),
        "IQ_SERVER_URL=https://from-file.example.com\nIQ_SERVER_TOKEN=file-token\nIQ_APP_ID=file-app\n",
        "utf-8",
      );
      const config = loadEnvConfig(TEST_DIR);
      expect(config.iqServerUrl).toBe("https://from-file.example.com");

      // Restore
      if (origEnv !== undefined) process.env.IQ_SERVER_URL = origEnv;
      else delete process.env.IQ_SERVER_URL;
      if (originalAllow !== undefined) process.env.ALLOW_PROJECT_SERVICE_CONFIG = originalAllow;
      else delete process.env.ALLOW_PROJECT_SERVICE_CONFIG;
    });

    it("does not mix a project-controlled endpoint with trusted credentials", async () => {
      const originalUrl = process.env.IQ_SERVER_URL;
      const originalToken = process.env.IQ_SERVER_TOKEN;
      const originalApp = process.env.IQ_APP_ID;
      const originalAllow = process.env.ALLOW_PROJECT_SERVICE_CONFIG;
      process.env.IQ_SERVER_URL = "https://trusted.example.com";
      process.env.IQ_SERVER_TOKEN = "trusted-token";
      process.env.IQ_APP_ID = "trusted-app";
      process.env.ALLOW_PROJECT_SERVICE_CONFIG = "true";
      await writeFile(join(TEST_DIR, ".env"), "IQ_SERVER_URL=https://attacker.example.com\n", "utf-8");

      expect(loadEnvConfig(TEST_DIR).iqServerUrl).toBe("https://trusted.example.com");

      if (originalUrl === undefined) delete process.env.IQ_SERVER_URL; else process.env.IQ_SERVER_URL = originalUrl;
      if (originalToken === undefined) delete process.env.IQ_SERVER_TOKEN; else process.env.IQ_SERVER_TOKEN = originalToken;
      if (originalApp === undefined) delete process.env.IQ_APP_ID; else process.env.IQ_APP_ID = originalApp;
      if (originalAllow === undefined) delete process.env.ALLOW_PROJECT_SERVICE_CONFIG; else process.env.ALLOW_PROJECT_SERVICE_CONFIG = originalAllow;
    });

    it("falls back to process.env when .env has no value", () => {
      const config = loadEnvConfig(TEST_DIR);
      // process.env LOG_LEVEL should be used if not in .env
      expect(config.logLevel).toBeDefined();
    });

    it("rejects invalid trusted log levels", () => {
      const original = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = "verbose";
      try {
        expect(() => loadEnvConfig(TEST_DIR)).toThrow("LOG_LEVEL must be one of");
      } finally {
        if (original === undefined) delete process.env.LOG_LEVEL;
        else process.env.LOG_LEVEL = original;
      }
    });

    it("never forwards IQ or Nexus secrets through Maven allowlisting", () => {
      const original = process.env.MAVEN_ENV_ALLOWLIST;
      process.env.MAVEN_ENV_ALLOWLIST = "HTTP_PROXY,IQ_SERVER_TOKEN,NEXUS_PASSWORD";
      try {
        expect(() => loadEnvConfig(TEST_DIR)).toThrow("must not expose service secrets");
      } finally {
        if (original === undefined) delete process.env.MAVEN_ENV_ALLOWLIST;
        else process.env.MAVEN_ENV_ALLOWLIST = original;
      }
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
        mavenEnvAllowlist: [],
        allowInsecureHttp: false,
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
        mavenEnvAllowlist: [],
        allowInsecureHttp: false,
      });
      expect(errors).toEqual([]);
    });
  });
});
