// Custom error classes for the MCP server

export class MCPError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly phase?: string,
    public readonly recoverable: boolean = true
  ) {
    super(message);
    this.name = 'MCPError';
  }
}

export class ConfigurationError extends MCPError {
  constructor(message: string) {
    super(message, 'CONFIGURATION_ERROR', undefined, false);
    this.name = 'ConfigurationError';
  }
}

export class IQServerError extends MCPError {
  constructor(message: string, phase?: string) {
    super(message, 'IQ_SERVER_ERROR', phase);
    this.name = 'IQServerError';
  }
}

export class NexusError extends MCPError {
  constructor(message: string, phase?: string) {
    super(message, 'NEXUS_ERROR', phase);
    this.name = 'NexusError';
  }
}

export class MavenError extends MCPError {
  constructor(message: string, phase?: string) {
    super(message, 'MAVEN_ERROR', phase);
    this.name = 'MavenError';
  }
}

export class GitError extends MCPError {
  constructor(message: string, phase?: string) {
    super(message, 'GIT_ERROR', phase);
    this.name = 'GitError';
  }
}

export class POMError extends MCPError {
  constructor(message: string, phase?: string) {
    super(message, 'POM_ERROR', phase);
    this.name = 'POMError';
  }
}

export class ValidationError extends MCPError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', undefined, false);
    this.name = 'ValidationError';
  }
}

export class RollbackError extends MCPError {
  constructor(message: string) {
    super(message, 'ROLLBACK_ERROR', undefined, false);
    this.name = 'RollbackError';
  }
}

// Error handler for MCP tools
export function handleToolError(error: unknown): { isError: true; content: { type: 'text'; text: string }[] } {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorCode = error instanceof MCPError ? error.code : 'UNKNOWN_ERROR';

  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: errorCode,
        message: errorMessage,
        recoverable: error instanceof MCPError ? error.recoverable : true,
      }, null, 2),
    }],
  };
}
