/**
 * Outcome class of a run that did not succeed, and what happened to its work.
 *
 * `escalated` and `failed` say how a run ended, not whose problem it is. The
 * outcome class answers that, so routine holds and real DevIntern breakage
 * stop looking alike:
 *
 * | Class         | Meaning                                                                 |
 * | ------------- | ----------------------------------------------------------------------- |
 * | `review_hold` | a policy/agent review or auto-merge rule wants a human's approval       |
 * | `agent`       | the agent could not complete the task (gave up, tests failing, unclear) |
 * | `internal`    | a DevIntern pipeline step failed (verify, git, PR creation, a crash)    |
 * | `environment` | credentials, auth, network, rate limits, a missing tool                 |
 *
 * Classification happens where the failure is known (a stage's catch block,
 * a step's halt, a caught worker exception) through {@link noteRunFailure}
 * in `run-recorder.ts`; this module only holds the domain types and the pure
 * helpers those sites share. A run nothing classified stays unclassified.
 */

import { redactText } from "@devintern/utils";

export const RUN_OUTCOME_CLASSES = ["review_hold", "agent", "internal", "environment"] as const;

export type RunOutcomeClass = (typeof RUN_OUTCOME_CLASSES)[number];

export function isRunOutcomeClass(value: unknown): value is RunOutcomeClass {
  return typeof value === "string" && (RUN_OUTCOME_CLASSES as readonly string[]).includes(value);
}

/**
 * Where a non-successful run's work went: `saved` to a pushed branch, `kept`
 * in a worktree on disk, `discarded`, or `none` when there was nothing to save.
 */
export const RUN_WORK_STATUSES = ["saved", "kept", "discarded", "none"] as const;

export type RunWorkStatus = (typeof RUN_WORK_STATUSES)[number];

export function isRunWorkStatus(value: unknown): value is RunWorkStatus {
  return typeof value === "string" && (RUN_WORK_STATUSES as readonly string[]).includes(value);
}

/** Work status plus the branch (`saved`) or worktree path (`kept`) it names. */
export interface RunWork {
  status: RunWorkStatus;
  ref?: string;
}

/** A classified failure: whose problem it is, which stage failed, and why. */
export interface RunFailure {
  outcomeClass: RunOutcomeClass;
  /** Pipeline stage or step that failed (`verify`, `publish`, `worktree_setup`, …). */
  stage?: string;
  /**
   * One-line, redacted cause. When set, the run's outcome reason becomes
   * `<stage>: <cause>` instead of the caller's generic phrase.
   */
  cause?: string;
}

/** Cap on a recorded cause, so a long stack or git dump stays one readable line. */
export const MAX_FAILURE_CAUSE_CHARS = 240;

/**
 * Normalize a step name into a stage label: configured pipeline steps are
 * named `__verify-2`, `__repair-0`; the label is `verify`, `repair`.
 *
 * @param step - Step or stage name
 */
export function failureStageName(step: string): string {
  const name = step
    .trim()
    .replace(/^_+/, "")
    .replace(/-\d+$/, "")
    .replace(/[^a-z0-9_-]+/gi, "_")
    .toLowerCase();
  return name || "unknown";
}

/**
 * Reduce an error message to a one-line, redacted cause: secrets are masked,
 * `Error:` prefixes and git `hint:` lines dropped, whitespace collapsed, and
 * the result truncated at a word boundary.
 *
 * @param message - Raw error message
 * @param max - Character cap (default {@link MAX_FAILURE_CAUSE_CHARS})
 */
export function formatFailureCause(message: string, max = MAX_FAILURE_CAUSE_CHARS): string {
  const lines = redactText(message)
    .split("\n")
    .map((line) => line.replace(/^\s*(?:(?:fatal|error)\s*:\s*)+/i, "").trim())
    .filter((line) => line !== "" && !/^hint:/i.test(line));
  const line = (lines[0] ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** `verify: remote branch … not found`, or undefined when the failure has no cause. */
export function describeRunFailure(failure: RunFailure | undefined): string | undefined {
  if (!failure?.cause) return undefined;
  return failure.stage ? `${failure.stage}: ${failure.cause}` : failure.cause;
}

/** Error names that always mean the environment, not DevIntern or the agent. */
const ENVIRONMENT_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AuthenticationError",
  "HarnessUnavailableError",
]);

/** Node/Bun network error codes. */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/**
 * Messages that name credentials, network reachability, rate limits, or a
 * missing tool. Deliberately specific: a bare "not found" (a missing branch,
 * a missing file) is a pipeline problem, not the environment.
 */
const ENVIRONMENT_MESSAGE =
  /\b(?:unauthori[sz]ed|bad credentials|authentication (?:failed|required)|invalid (?:api )?(?:token|key|credentials)|token (?:has )?expired|could not read username|requires authentication|rate limit(?:ed)?|too many requests|secondary rate limit|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|could not resolve host|network is unreachable|socket hang up|certificate (?:has expired|verify failed)|command not found|executable not found|spawn \S+ ENOENT)\b|\b(?:HTTP|status(?: code)?)[\s:]*(?:401|403|407|429)\b|\b(?:401|407) (?:unauthori[sz]ed|proxy)|\b429 too many\b|\bpermission denied \(publickey\)/i;

/**
 * Whether a caught error is an environment problem (credentials, network,
 * rate limits, missing tools) rather than a DevIntern or agent failure.
 *
 * @param error - Caught error
 */
export function isEnvironmentError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return typeof error === "string" && ENVIRONMENT_MESSAGE.test(error);
  }
  if (ENVIRONMENT_ERROR_NAMES.has(error.name)) return true;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
  return ENVIRONMENT_MESSAGE.test(error.message);
}

/** Property an error carries when the code that threw it knows its class. */
const OUTCOME_CLASS_PROPERTY = "runOutcomeClass";

interface OutcomeClassTag {
  outcomeClass: RunOutcomeClass;
  /** The message is not DevIntern's own (hook or test output): skip the environment check. */
  definite: boolean;
}

/**
 * Mark an error with the outcome class the throwing code knows, e.g. `agent`
 * for an agent that exited non-zero or timed out. {@link failureFromError}
 * prefers this tag over its caller's fallback, so an agent failure that
 * bubbles up to a generic catch block is not reported as a DevIntern bug.
 *
 * A message that names credentials or the network still classes as
 * `environment`, unless `definite` is set: use that when the message embeds
 * output DevIntern does not control (a git hook's test run can print
 * `ECONNREFUSED` without the environment being at fault).
 *
 * @param error - Error to tag (returned for `throw tagOutcomeClass(…)`)
 * @param outcomeClass - Class to record
 * @param options - `definite`: the tag wins over the environment check
 */
export function tagOutcomeClass<E extends Error>(
  error: E,
  outcomeClass: RunOutcomeClass,
  options: { definite?: boolean } = {},
): E {
  const tag: OutcomeClassTag = { outcomeClass, definite: options.definite === true };
  Object.defineProperty(error, OUTCOME_CLASS_PROPERTY, {
    value: tag,
    enumerable: false,
    configurable: true,
  });
  return error;
}

function outcomeClassTag(error: unknown): OutcomeClassTag | undefined {
  if (!(error instanceof Error)) return undefined;
  const value: unknown = (error as Error & { [OUTCOME_CLASS_PROPERTY]?: unknown })[
    OUTCOME_CLASS_PROPERTY
  ];
  if (typeof value !== "object" || value === null) return undefined;
  const tag = value as Partial<OutcomeClassTag>;
  return isRunOutcomeClass(tag.outcomeClass)
    ? { outcomeClass: tag.outcomeClass, definite: tag.definite === true }
    : undefined;
}

/** The class {@link tagOutcomeClass} put on an error, if any. */
export function taggedOutcomeClass(error: unknown): RunOutcomeClass | undefined {
  return outcomeClassTag(error)?.outcomeClass;
}

function classifyError(error: unknown, fallback: RunOutcomeClass): RunOutcomeClass {
  const tag = outcomeClassTag(error);
  if (tag?.definite) return tag.outcomeClass;
  if (isEnvironmentError(error)) return "environment";
  return tag?.outcomeClass ?? fallback;
}

/**
 * Classify a failure caught at a DevIntern step: `environment` when the error
 * names credentials, network, rate limits, or a missing tool (unless a
 * definite tag says otherwise); otherwise the class the error was tagged
 * with ({@link tagOutcomeClass}), or the caller's fallback (`internal` for
 * pipeline machinery).
 *
 * @param error - Caught error (or its message)
 * @param stage - Stage or step that failed
 * @param fallback - Class when the error is neither environmental nor tagged
 */
export function failureFromError(
  error: unknown,
  stage: string | undefined,
  fallback: RunOutcomeClass = "internal",
): RunFailure {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const cause = formatFailureCause(message);
  return {
    outcomeClass: classifyError(error, fallback),
    ...(stage ? { stage: failureStageName(stage) } : {}),
    ...(cause ? { cause } : {}),
  };
}
