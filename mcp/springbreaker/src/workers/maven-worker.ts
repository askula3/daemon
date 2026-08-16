import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createChildLogger } from "../utils/logger.js";
import { MavenError } from "../utils/errors.js";
import type { MavenResult } from "../types/index.js";

const log = createChildLogger("MavenWorker");
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SAFE_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "JAVA_HOME", "JDK_HOME", "M2_HOME", "MAVEN_HOME", "LANG", "LC_ALL", "TZ",
  "SystemRoot", "COMSPEC", "PATHEXT",
];

function boundedAppend(current: string, chunk: Buffer, limit: number): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) <= limit) return next;
  const marker = "\n[... output truncated to the most recent bytes ...]\n";
  return marker + Buffer.from(next).subarray(-limit).toString();
}

export function parseUnusedDeclaredDependencies(
  output: string,
): Array<{ groupId: string; artifactId: string }> {
  const unused: Array<{ groupId: string; artifactId: string }> = [];
  let collecting = false;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/^\[(?:INFO|WARNING|WARN|ERROR)\]\s*/, "").trim();
    if (line === "Unused declared dependencies found:") {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    const parts = line.split(":");
    if ((parts.length === 5 || parts.length === 6) && parts[0] && parts[1]) {
      unused.push({ groupId: parts[0], artifactId: parts[1] });
    } else if (line && !line.startsWith("None")) {
      collecting = false;
    }
  }
  return [...new Map(unused.map((dependency) =>
    [`${dependency.groupId}:${dependency.artifactId}`, dependency],
  )).values()];
}

export class MavenWorker {
  private preferMvnw: boolean;
  private mavenOpts?: string;
  private envAllowlist: string[];
  private maxOutputBytes: number;

  constructor(
    preferMvnw: boolean = true,
    mavenOpts?: string,
    envAllowlist: string[] = [],
    maxOutputBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
  ) {
    this.preferMvnw = preferMvnw;
    this.mavenOpts = mavenOpts;
    this.envAllowlist = [...envAllowlist];
    this.maxOutputBytes = maxOutputBytes;
  }

  // Find Maven executable
  private findMaven(projectPath: string): string {
    // Check for Maven wrapper
    if (this.preferMvnw) {
      const mvnw = join(projectPath, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
      try {
        accessSync(mvnw, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return mvnw;
      } catch {
        // Fall back to a Maven executable on PATH without changing wrapper permissions.
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
      signal?: AbortSignal;
    } = {},
  ): Promise<MavenResult> {
    const maven = this.findMaven(projectPath);
    const args = this.buildArgs(goals, options);

    log.info(`Executing: ${maven} ${args.join(" ")}`);
    const startTime = Date.now();

    return new Promise<MavenResult>((resolve) => {
      const env: NodeJS.ProcessEnv = {};
      for (const key of new Set([...SAFE_ENV_KEYS, ...this.envAllowlist])) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      if (this.mavenOpts) env.MAVEN_OPTS = this.mavenOpts;

      const child = spawn(maven, args, {
        cwd: projectPath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout = boundedAppend(stdout, data, this.maxOutputBytes);
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr = boundedAppend(stderr, data, this.maxOutputBytes);
      });

      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let forceFinishTimer: NodeJS.Timeout | undefined;
      let terminationMessage: string | undefined;
      const finish = (result: MavenResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(commandTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (forceFinishTimer) clearTimeout(forceFinishTimer);
        options.signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const signalProcess = (signal: NodeJS.Signals): void => {
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, signal);
          } catch {
            child.kill(signal);
          }
        } else {
          child.kill(signal);
        }
      };
      const terminate = (message: string): void => {
        if (terminationMessage) return;
        terminationMessage = message;
        signalProcess("SIGTERM");
        forceKillTimer = setTimeout(() => {
          signalProcess("SIGKILL");
          forceFinishTimer = setTimeout(() => finish({
            exitCode: 1,
            stdout,
            stderr: stderr || terminationMessage || message,
            duration: Date.now() - startTime,
            success: false,
          }), 1_000);
          forceFinishTimer.unref();
        }, 5_000);
        forceKillTimer.unref();
      };
      const abort = (): void => {
        terminate("Maven command cancelled");
      };
      const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
      const commandTimer = setTimeout(() =>
        terminate(`Maven command timed out after ${timeout}ms`), timeout);
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });

      child.on("close", (code) => {
        const duration = Date.now() - startTime;
        finish({
          exitCode: terminationMessage ? 1 : code ?? 1,
          stdout,
          stderr: stderr || terminationMessage || "",
          duration,
          success: !terminationMessage && code === 0,
        });
      });

      child.on("error", (err) => {
        const duration = Date.now() - startTime;
        finish({
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
  async getDependencyTree(
    projectPath: string,
    options: { timeout?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const result = await this.execute(projectPath, ["dependency:tree"], {
      properties: { outputType: "text" },
      timeout: options.timeout,
      signal: options.signal,
    });

    if (!result.success) {
      throw new MavenError(`Failed to get dependency tree: ${result.stderr}`);
    }

    return result.stdout;
  }

  /**
   * Run the pinned Maven Dependency Plugin against one module POM and parse
   * only its explicit "Unused declared dependencies" section. Failures are
   * surfaced so callers can keep usage as unknown instead of guessing.
   */
  async analyzeUnusedDependencies(
    projectPath: string,
    pomPath: string,
    options: { timeout?: number; signal?: AbortSignal } = {},
  ): Promise<Array<{ groupId: string; artifactId: string }>> {
    const result = await this.execute(projectPath, [
      "-f",
      pomPath,
      "org.apache.maven.plugins:maven-dependency-plugin:3.8.1:analyze-only",
    ], {
      properties: { ignoreNonCompile: "true" },
      timeout: options.timeout,
      signal: options.signal,
    });
    if (!result.success) {
      throw new MavenError(`Failed to analyze dependency usage for ${pomPath}: ${result.stderr}`);
    }

    return parseUnusedDeclaredDependencies(`${result.stdout}\n${result.stderr}`);
  }

  // Run clean verify
  async cleanVerify(
    projectPath: string,
    skipTests: boolean = false,
    options: { timeout?: number; signal?: AbortSignal } = {},
  ): Promise<MavenResult> {
    return this.execute(projectPath, ["clean", "verify"], {
      skipTests,
      timeout: options.timeout,
      signal: options.signal,
    });
  }

  /** Generate a CycloneDX JSON SBOM without writing into the project tree. */
  async generateCycloneDxBom(
    projectPath: string,
    outputDirectory: string,
    timeout: number = DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.execute(
      projectPath,
      ["org.cyclonedx:cyclonedx-maven-plugin:2.9.1:makeAggregateBom"],
      {
        timeout,
        signal,
        properties: {
          outputFormat: "json",
          outputName: "springbreaker-bom",
          outputDirectory,
          schemaVersion: "1.5",
          includeBomSerialNumber: "true",
        },
      },
    );
    if (!result.success) {
      throw new MavenError(`Failed to generate CycloneDX SBOM: ${result.stderr}`);
    }
    const bomPath = join(outputDirectory, "springbreaker-bom.json");
    if (!existsSync(bomPath)) {
      throw new MavenError(`CycloneDX plugin did not create expected SBOM: ${bomPath}`);
    }
    return bomPath;
  }

  // Check if Maven is available
  async checkMavenAvailable(projectPath: string): Promise<boolean> {
    if (this.preferMvnw) {
      const wrapper = join(projectPath, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
      try {
        accessSync(wrapper, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        // Continue searching PATH.
      }
    }
    const executableNames = process.platform === "win32"
      ? ["mvn.cmd", "mvn.exe", "mvn.bat"]
      : ["mvn"];
    for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
      if (!pathEntry) continue;
      for (const executable of executableNames) {
        try {
          accessSync(join(pathEntry, executable), constants.X_OK);
          return true;
        } catch {
          // Continue searching PATH.
        }
      }
    }
    return false;
  }

  // Get Java version used by Maven
  async getJavaVersion(projectPath: string): Promise<string> {
    const result = await this.execute(projectPath, [
      "help:evaluate",
      "-Dexpression=java.version",
      "-q",
      "-DforceStdout",
    ]);

    if (!result.success) {
      throw new MavenError(`Failed to get Java version: ${result.stderr}`);
    }

    return result.stdout.trim();
  }
}
