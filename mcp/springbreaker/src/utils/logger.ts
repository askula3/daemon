export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Structured context that can be attached to log messages (spec §41). */
export interface LogContext {
  executionId?: string;
  planId?: string;
  taskId?: string;
  project?: string;
  [key: string]: string | undefined;
}

class Logger {
  private level: LogLevel = "info";

  setLevel(level: LogLevel): void {
    if (level in LOG_LEVELS) {
      this.level = level;
    }
  }

  getLevel(): LogLevel {
    return this.level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatMessage(
    level: LogLevel,
    message: string,
    context?: string,
    structured?: LogContext,
  ): string {
    const timestamp = new Date().toISOString();
    const prefix = context ? `[${context}]` : "";
    const ctxStr = structured
      ? " " +
        Object.entries(structured)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
      : "";
    return `${timestamp} ${level.toUpperCase().padEnd(5)} ${prefix}${ctxStr} ${message}`;
  }

  debug(
    message: string,
    context?: string,
    structured?: LogContext,
    ...args: unknown[]
  ): void {
    if (this.shouldLog("debug")) {
      console.error(
        this.formatMessage("debug", message, context, structured),
        ...args,
      );
    }
  }

  info(
    message: string,
    context?: string,
    structured?: LogContext,
    ...args: unknown[]
  ): void {
    if (this.shouldLog("info")) {
      console.error(
        this.formatMessage("info", message, context, structured),
        ...args,
      );
    }
  }

  warn(
    message: string,
    context?: string,
    structured?: LogContext,
    ...args: unknown[]
  ): void {
    if (this.shouldLog("warn")) {
      console.error(
        this.formatMessage("warn", message, context, structured),
        ...args,
      );
    }
  }

  error(
    message: string,
    context?: string,
    structured?: LogContext,
    ...args: unknown[]
  ): void {
    if (this.shouldLog("error")) {
      console.error(
        this.formatMessage("error", message, context, structured),
        ...args,
      );
    }
  }

  // MCP-specific logging (sends to client)
  mcpLog(level: "debug" | "info" | "warning" | "error", message: string): void {
    const timestamp = new Date().toISOString();
    const prefix = level.toUpperCase().padEnd(7);
    console.error(`${timestamp} ${prefix} ${message}`);
  }
}

export const logger = new Logger();

type ChildLogger = {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  withContext: (extra: LogContext) => ChildLogger;
  structured: LogContext | undefined;
};

export function createChildLogger(context: string, structured?: LogContext): ChildLogger {
  const child: ChildLogger = {
    debug: (message: string, ...args: unknown[]) =>
      logger.debug(message, context, structured, ...args),
    info: (message: string, ...args: unknown[]) =>
      logger.info(message, context, structured, ...args),
    warn: (message: string, ...args: unknown[]) =>
      logger.warn(message, context, structured, ...args),
    error: (message: string, ...args: unknown[]) =>
      logger.error(message, context, structured, ...args),

    /**
     * Create a new child logger with additional structured context merged
     * with the existing context. Useful for adding executionId, planId, taskId
     * at the point where those values are known (spec §41).
     */
    withContext(extra: LogContext): ReturnType<typeof createChildLogger> {
      return createChildLogger(context, { ...structured, ...extra });
    },

    /** The structured context carried by this logger instance. */
    structured,
  };
  return child;
}

/**
 * Start a timer for measuring operation duration.
 * Returns a function that returns elapsed milliseconds.
 */
export function startTimer(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}
