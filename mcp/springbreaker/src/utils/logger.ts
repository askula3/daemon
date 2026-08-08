export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatMessage(level: LogLevel, message: string, context?: string): string {
    const timestamp = new Date().toISOString();
    const prefix = context ? `[${context}]` : '';
    return `${timestamp} ${level.toUpperCase().padEnd(5)} ${prefix} ${message}`;
  }

  debug(message: string, context?: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.error(this.formatMessage('debug', message, context), ...args);
    }
  }

  info(message: string, context?: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.error(this.formatMessage('info', message, context), ...args);
    }
  }

  warn(message: string, context?: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.error(this.formatMessage('warn', message, context), ...args);
    }
  }

  error(message: string, context?: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, context), ...args);
    }
  }

  // MCP-specific logging (sends to client)
  mcpLog(level: 'debug' | 'info' | 'warning' | 'error', message: string): void {
    // For MCP, logs go to stderr to avoid interfering with JSON-RPC
    const timestamp = new Date().toISOString();
    const prefix = level.toUpperCase().padEnd(7);
    console.error(`${timestamp} ${prefix} ${message}`);
  }
}

export const logger = new Logger();

export function createChildLogger(context: string) {
  return {
    debug: (message: string, ...args: unknown[]) => logger.debug(message, context, ...args),
    info: (message: string, ...args: unknown[]) => logger.info(message, context, ...args),
    warn: (message: string, ...args: unknown[]) => logger.warn(message, context, ...args),
    error: (message: string, ...args: unknown[]) => logger.error(message, context, ...args),
  };
}
