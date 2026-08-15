import { spawn } from "node:child_process";
import { existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createChildLogger } from "../utils/logger.js";
import { MavenError } from "../utils/errors.js";
import type { MavenResult } from "../types/index.js";

const log = createChildLogger("MavenWorker");

export class MavenWorker {
  private preferMvnw: boolean;
  private mavenOpts?: string;

  constructor(preferMvnw: boolean = true, mavenOpts?: string) {
    this.preferMvnw = preferMvnw;
    this.mavenOpts = mavenOpts;
  }

  // Find Maven executable
  private findMaven(projectPath: string): string {
    // Check for Maven wrapper
    if (this.preferMvnw) {
      const mvnw = join(projectPath, "mvnw");
      if (existsSync(mvnw)) {
        // Ensure mvnw is executable
        try {
          chmodSync(mvnw, 0o755);
        } catch {
          // Ignore chmod errors
        }
        return mvnw;
      }
    }

    // Fall back to mvn
    return "mvn";
  }

  // Execute Maven command using spawn (safe against shell injection)
  async execute(
    projectPath: string,
    goals: string[],
    options: {
      profiles?: string[];
      properties?: Record<string, string>;
      skipTests?: boolean;
      threads?: string;
      timeout?: number;
    } = {},
  ): Promise<MavenResult> {
    const maven = this.findMaven(projectPath);
    const args = this.buildArgs(goals, options);

    log.info(`Executing: ${maven} ${args.join(" ")}`);
    const startTime = Date.now();

    return new Promise<MavenResult>((resolve) => {
      const env = {
        ...process.env,
        ...(this.mavenOpts ? { MAVEN_OPTS: this.mavenOpts } : {}),
      };

      const child = spawn(maven, args, {
        cwd: projectPath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      const timeout = options.timeout || 300000; // 5 minutes default
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        const duration = Date.now() - startTime;
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr || "Maven command timed out",
          duration,
          success: false,
        });
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        const duration = Date.now() - startTime;
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          duration,
          success: code === 0,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        const duration = Date.now() - startTime;
        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message || "Failed to spawn Maven process",
          duration,
          success: false,
        });
      });
    });
  }

  // Build Maven arguments
  private buildArgs(
    goals: string[],
    options: {
      profiles?: string[];
      properties?: Record<string, string>;
      skipTests?: boolean;
      threads?: string;
    },
  ): string[] {
    const args: string[] = [];

    // Add goals
    args.push(...goals);

    // Add profiles
    if (options.profiles && options.profiles.length > 0) {
      args.push(`-P${options.profiles.join(",")}`);
    }

    // Add properties
    if (options.properties) {
      for (const [key, value] of Object.entries(options.properties)) {
        args.push(`-D${key}=${value}`);
      }
    }

    // Skip tests
    if (options.skipTests) {
      args.push("-DskipTests=true");
    }

    // Threads
    if (options.threads) {
      args.push(`-T${options.threads}`);
    }

    // Batch mode (no interaction)
    args.push("-B");

    // Note: we intentionally do NOT use -q (quiet mode) because it suppresses
    // diagnostic output that is essential for debugging build failures.

    return args;
  }

  // Get dependency tree
  async getDependencyTree(projectPath: string): Promise<string> {
    const result = await this.execute(projectPath, ["dependency:tree"], {
      properties: { outputType: "text" },
    });

    if (!result.success) {
      throw new MavenError(`Failed to get dependency tree: ${result.stderr}`);
    }

    return result.stdout;
  }

  // Run clean verify
  async cleanVerify(
    projectPath: string,
    skipTests: boolean = false,
  ): Promise<MavenResult> {
    return this.execute(projectPath, ["clean", "verify"], { skipTests });
  }

  // Check if Maven is available
  async checkMavenAvailable(projectPath: string): Promise<boolean> {
    try {
      const result = await this.execute(projectPath, ["--version"]);
      return result.success;
    } catch {
      return false;
    }
  }

  // Get Java version used by Maven
  async getJavaVersion(projectPath: string): Promise<string> {
    const result = await this.execute(projectPath, ["help:evaluate"], {
      properties: { expression: "java.version", q: "true" },
    });

    if (!result.success) {
      throw new MavenError(`Failed to get Java version: ${result.stderr}`);
    }

    return result.stdout.trim();
  }
}
