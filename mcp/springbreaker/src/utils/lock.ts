/**
 * Project-level concurrency lock.
 *
 * Prevents concurrent Maven builds, POM modifications, and git operations
 * on the same project path. The MCP server can receive multiple tool calls
 * concurrently — without this lock, two `execute_plan` calls on the same
 * project would corrupt each other's state.
 *
 * Usage:
 *   await withProjectLock(projectPath, async () => {
 *     // critical section
 *   });
 */

const locks = new Map<string, Promise<void>>();

/**
 * Acquire a project-level mutex and execute `fn` exclusively.
 * All concurrent callers for the same projectPath will queue up.
 */
export async function withProjectLock<T>(
  projectPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(projectPath) ?? Promise.resolve();

  const next = prev.then(
    () => fn(),
    () => fn(), // If previous failed, still allow next to proceed
  );

  // Register the new promise, then clean up after it settles.
  // Store the cleanup promise in a variable so the finally block can compare
  // against the SAME reference — previously `next.then(...)` was called twice,
  // creating two distinct promises, so the comparison never matched and the
  // map entry leaked forever.
  const cleanup: Promise<void> = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(projectPath, cleanup);

  try {
    return await next;
  } finally {
    // If this is the last promise in the chain, remove the entry
    if (locks.get(projectPath) === cleanup) {
      locks.delete(projectPath);
    }
  }
}

/**
 * Check if a project is currently locked.
 */
export function isProjectLocked(projectPath: string): boolean {
  return locks.has(projectPath);
}

/**
 * Get the number of currently locked projects (for diagnostics).
 */
export function lockedProjectCount(): number {
  return locks.size;
}