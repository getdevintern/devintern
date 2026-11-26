/**
 * Retry budget, backoff, and operator hints for an agent CLI that keeps
 * failing to start (bad API key, missing login, broken install).
 *
 * A harness that exits before producing output is classified "could not
 * start" (`harness-startup.ts`) and the worker defers the task instead of
 * charging an attempt. Without a budget that loops forever: the same task is
 * re-tried every couple of minutes while the worker looks healthy. These
 * helpers bound it:
 *
 * - each consecutive start failure of a harness doubles its cooldown
 *   ({@link agentStartRetryDelayMs}), so the whole chain backs off;
 * - after {@link agentStartMaxAttempts} consecutive start failures of one task,
 *   the task child settles the run `failed` (class `environment`, stage
 *   {@link AGENT_START_STAGE}) instead of deferring again;
 * - every start-failure run records its reason as `agent_start: <cause>` so
 *   status surfaces ({@link parseAgentStartReason}) can find them.
 */

import {
  AGENT_START_REASON_PREFIX,
  AGENT_START_STAGE,
  formatFailureCause,
} from "../state/run-outcome";

export { AGENT_START_STAGE };

/** Default consecutive start failures of one task before it is settled `failed`. */
export const DEFAULT_AGENT_START_MAX_ATTEMPTS = 5;

/** Environment override for {@link DEFAULT_AGENT_START_MAX_ATTEMPTS}. */
export const AGENT_START_MAX_ATTEMPTS_ENV = "DEVINTERN_AGENT_START_MAX_ATTEMPTS";

/** Cooldown after the first start failure of a harness. */
export const AGENT_START_RETRY_BASE_MS = 60_000;

/** Longest cooldown between start attempts of one harness. */
export const AGENT_START_RETRY_MAX_MS = 30 * 60_000;

/**
 * Consecutive start failures a task may have before it is settled `failed`.
 *
 * @param env - Environment to read {@link AGENT_START_MAX_ATTEMPTS_ENV} from
 * @returns A positive integer (invalid overrides fall back to the default)
 */
export function agentStartMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[AGENT_START_MAX_ATTEMPTS_ENV]?.trim();
  if (!raw) return DEFAULT_AGENT_START_MAX_ATTEMPTS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_AGENT_START_MAX_ATTEMPTS;
}

/**
 * Cooldown before a harness that failed to start is tried again: 1m, 2m, 4m,
 * ... capped at {@link AGENT_START_RETRY_MAX_MS}.
 *
 * @param streak - Consecutive start failures of the harness, including this one (1-based)
 */
export function agentStartRetryDelayMs(streak: number): number {
  const exponent = Math.min(Math.max(0, streak - 1), 20);
  return Math.min(AGENT_START_RETRY_BASE_MS * 2 ** exponent, AGENT_START_RETRY_MAX_MS);
}

/**
 * Outcome reason recorded for a start failure: `agent_start: <cause>`, with
 * the cause redacted and cut to one line.
 *
 * @param message - The `HarnessUnavailableError` message
 */
export function agentStartReason(message: string): string {
  return `${AGENT_START_REASON_PREFIX}${formatFailureCause(message)}`;
}

/**
 * The cause of a start-failure outcome reason, or undefined for any other
 * reason.
 *
 * @param reason - A run's `outcome_reason`
 */
export function parseAgentStartReason(reason: string | null | undefined): string | undefined {
  if (!reason?.startsWith(AGENT_START_REASON_PREFIX)) return undefined;
  return (
    reason.slice(AGENT_START_REASON_PREFIX.length).trim() ||
    "the agent CLI exited before producing output"
  );
}

/** Per-harness login/credential hint for an agent CLI that exits at once. */
const LOGIN_HINTS: Record<string, string> = {
  "claude-code": "run `claude` once in a terminal to log in, or check ANTHROPIC_API_KEY",
  codex: "run `codex login` in a terminal, or check OPENAI_API_KEY",
  antigravity: "run `agy` once in a terminal to sign in, or check ANTIGRAVITY_TOKEN",
};

/**
 * One-line fix hint for a start failure.
 *
 * @param harness - Harness name the run used (`claude-code`), when known
 * @param cause - The recorded cause
 */
export function agentStartFixHint(harness: string | undefined, cause: string): string {
  if (/\bnot found\b|\bENOENT\b/i.test(cause)) {
    return "install the agent CLI, or set AGENT_CLI_PATH / <HARNESS>_CLI_PATH in the workspace .env; then run `devintern worker doctor`";
  }
  if (/sandbox|landlock|seatbelt|path_not_granted|nono:/i.test(cause)) {
    return "run `devintern sandbox` to check the sandbox setup, or set AGENT_SANDBOX=none to rule it out";
  }
  return (
    (harness ? LOGIN_HINTS[harness] : undefined) ??
    "run the agent CLI once in a terminal as the worker's user to check that it is logged in and its API key is set"
  );
}
