import { describe, it, expect } from "vitest";
import {
  MCPError,
  ConfigurationError,
  IQServerError,
  NexusError,
  MavenError,
  GitError,
  POMError,
  ValidationError,
  RollbackError,
  handleToolError,
} from "../../src/utils/errors.js";

describe("Error classes", () => {
  describe("MCPError", () => {
    it("has correct base properties", () => {
      const error = new MCPError("test message", "TEST_CODE", "test-phase", false);
      expect(error.message).toBe("test message");
      expect(error.code).toBe("TEST_CODE");
      expect(error.phase).toBe("test-phase");
      expect(error.recoverable).toBe(false);
      expect(error.name).toBe("MCPError");
    });

    it("defaults recoverable to true", () => {
      const error = new MCPError("test", "CODE", "phase");
      expect(error.recoverable).toBe(true);
    });
  });

  describe("specific error classes", () => {
    it("ConfigurationError has correct defaults", () => {
      const error = new ConfigurationError("bad config");
      expect(error.code).toBe("CONFIGURATION_ERROR");
      expect(error.recoverable).toBe(false);
    });

    it("IQServerError has correct defaults", () => {
      const error = new IQServerError("iq down", "scan");
      expect(error.code).toBe("IQ_SERVER_ERROR");
      expect(error.phase).toBe("scan");
      expect(error.recoverable).toBe(true);
    });

    it("NexusError has correct defaults", () => {
      const error = new NexusError("nexus down", "search");
      expect(error.code).toBe("NEXUS_ERROR");
      expect(error.phase).toBe("search");
      expect(error.recoverable).toBe(true);
    });

    it("MavenError has correct defaults", () => {
      const error = new MavenError("build failed");
      expect(error.code).toBe("MAVEN_ERROR");
      expect(error.recoverable).toBe(true);
    });

    it("GitError has correct defaults", () => {
      const error = new GitError("git failed");
      expect(error.code).toBe("GIT_ERROR");
      expect(error.recoverable).toBe(true);
    });

    it("POMError has correct defaults", () => {
      const error = new POMError("pom broken");
      expect(error.code).toBe("POM_ERROR");
      expect(error.recoverable).toBe(true);
    });

    it("ValidationError has correct defaults", () => {
      const error = new ValidationError("invalid input");
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.recoverable).toBe(false);
    });

    it("RollbackError has correct defaults", () => {
      const error = new RollbackError("rollback failed");
      expect(error.code).toBe("ROLLBACK_ERROR");
      expect(error.recoverable).toBe(false);
    });
  });

  describe("handleToolError", () => {
    it("formats MCPError into isError response", () => {
      const error = new POMError("POM not found", "read-pom");
      const result = handleToolError(error);

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("POM_ERROR");
      expect(parsed.message).toBe("POM not found");
      expect(parsed.recoverable).toBe(true);
    });

    it("formats generic Error into isError response", () => {
      const error = new Error("something broke");
      const result = handleToolError(error);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("UNKNOWN_ERROR");
      expect(parsed.message).toBe("something broke");
    });

    it("formats string error into isError response", () => {
      const result = handleToolError("string error");

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.message).toBe("string error");
    });
  });
});
