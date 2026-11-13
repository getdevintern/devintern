/**
 * Process-wide shutdown state.
 *
 * Signal handlers run concurrently with in-flight pipeline work: a SIGTERM
 * during a verification attempt kills the agent child, and the retry loop used
 * to treat that exit as a verification failure — posting an "incomplete
 * implementation" comment on top of the shutdown handler's interruption
 * feedback. Pipeline steps consult this flag to stop retrying and let the
 * shutdown path own the single, accurate report.
 */

let shuttingDown = false;

/** Mark the process as shutting down (idempotent). */
export function beginShutdown(): void {
  shuttingDown = true;
}

/** Whether a termination signal is already being handled. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Clear the flag. Tests only — a real process exits after shutdown. */
export function resetShutdownState(): void {
  shuttingDown = false;
}
