import { createChildLogger } from "./logger.js";

const log = createChildLogger("Retry");

/** Options for the retry utility. */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3). */
  maxRetries?: number;
  /** Base delay in ms before the first retry (default: 1000). */
  baseDelayMs?: number;
  /** Maximum delay in ms between retries (default: 30000). */
  maxDelayMs?: number;
  /** Optional function to decide if the error is retryable. */
  isRetryable?: (error: unknown) => boolean;
  /** Label for log messages. */
  label?: string;
}

/**
 * HTTP status codes considered retryable (transient failures).
 * Non-retryable: 400, 401, 403, 404, 405, 409, 422.
 */
export function isRetryableHttpStatus(status: number): boolean {
  if (status === 429) return true; // Too Many Requests
  if (status >= 500) return true; // Server errors
  return false;
}

/**
 * Execute an async function with exponential backoff and jitter.
 *
 * Retries on retryable errors up to `maxRetries` times. Non-retryable
 * errors are thrown immediately. After exhausting retries, the last error
 * is thrown.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    isRetryable,
    label = "operation",
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if the error is retryable
      const retryable = isRetryable ? isRetryable(error) : true;

      if (!retryable || attempt >= maxRetries) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs,
        maxDelayMs,
      );

      log.warn(
        `${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), ` +
          `retrying in ${Math.round(delay)}ms: ${error instanceof Error ? error.message : String(error)}`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Unreachable, but TypeScript needs it
  throw lastError;
}
