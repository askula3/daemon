import pLimit from 'p-limit';

/**
 * Bounded concurrency limiters for external service calls.
 *
 * Spec §18: "Never use unbounded Promise.all() against company Nexus."
 * These limiters cap concurrent requests to protect external services.
 */

/** Default concurrency limits (spec §18). */
export const CONCURRENCY_LIMITS = {
  NEXUS: 5,
  IQ: 2,
  MAVEN: 1,
  POM_MUTATION: 1,
} as const;

/**
 * Create a concurrency limiter for a specific service.
 * The limiter ensures no more than `limit` promises run concurrently.
 */
export function createConcurrencyLimiter(limit: number) {
  return pLimit(limit);
}

/** Singleton limiters — shared across a single MCP server process. */
export const nexusLimit = createConcurrencyLimiter(CONCURRENCY_LIMITS.NEXUS);
export const iqLimit = createConcurrencyLimiter(CONCURRENCY_LIMITS.IQ);
export const mavenLimit = createConcurrencyLimiter(CONCURRENCY_LIMITS.MAVEN);
