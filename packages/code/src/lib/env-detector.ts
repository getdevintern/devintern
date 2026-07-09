/**
 * Detect whether the CLI is running in an automated/non-interactive environment.
 *
 * Returns true only with strong evidence (CI env vars, systemd markers).
 * Piped output alone does not count as automated.
 *
 * @returns `true` when running under CI, systemd, or similar unattended context
 */
export function isAutomatedEnvironment(): boolean {
  // CI systems (GitHub Actions, GitLab CI, Travis, etc.)
  if (process.env.CI) {
    return true;
  }

  // systemd-specific environment variables
  if (process.env.SYSTEMD_EXEC_PID || process.env.INVOCATION_ID || process.env.JOURNAL_STREAM) {
    return true;
  }

  return false;
}

/**
 * Detect whether stdout is attached to a TTY.
 *
 * @returns `true` when output goes to an interactive terminal
 */
export function isTtyOutput(): boolean {
  return !!process.stdout.isTTY;
}

/**
 * Return a short human-readable label for the detected runtime mode.
 *
 * @returns `"interactive"` or `"automated"`
 */
export function getRuntimeMode(): "interactive" | "automated" {
  return isAutomatedEnvironment() ? "automated" : "interactive";
}
