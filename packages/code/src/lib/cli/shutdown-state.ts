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
  signalsClaimed = false;
}

let signalsClaimed = false;

/**
 * Hand SIGINT/SIGTERM to a long-running command's own graceful shutdown.
 *
 * The CLI entry point installs a task-run shutdown handler for every command
 * that exits 130/143 as soon as it finishes. The worker daemon has its own,
 * slower shutdown (drain jobs, stop acquirers, release the lock, exit 0).
 * Once it claims the signals the entry-point handler stands aside, so
 * `systemctl --user stop` ends in a clean exit instead of status 143.
 */
export function claimSignalHandling(): void {
  signalsClaimed = true;
}

/** Whether a long-running command owns SIGINT/SIGTERM handling. */
export function isSignalHandlingClaimed(): boolean {
  return signalsClaimed;
}
