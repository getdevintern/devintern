/**
 * Muse Code harness constants.
 */

import type { MuseReasoningEffort } from "./types.js";

/** Subcommand for headless runs. */
export const MUSE_EXEC_SUBCOMMAND = "exec";

/** Always enabled for structured event parsing. */
export const MUSE_JSON_FLAG = "--json";

/** Interactive-only flags that must not be passed to `muse exec`. */
export const MUSE_INTERACTIVE_ONLY_FLAGS = ["approval-mode", "approval-judge"] as const;

/** Supported `--reasoning-effort` values for Muse Code. */
export const MUSE_REASONING_EFFORT_VALUES: readonly MuseReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
] as const;

/** Known Muse-specific option keys accepted in {@link MuseHarnessOptions}. */
export const MUSE_OPTION_KEYS = [
  "reasoningEffort",
  "sandboxNetwork",
  "disableSandbox",
  "disableApproval",
  "yolo",
  "trustWorkspace",
  "subagentWorktreeIsolation",
  "sessionId",
  "allowWorkspaceSwitch",
  "noSessionLog",
] as const;

/**
 * Prefer `--prompt-file` above this byte length (conservative vs typical ARG_MAX).
 * Override with `MUSE_PROMPT_FILE_THRESHOLD_BYTES`.
 */
export const DEFAULT_PROMPT_FILE_THRESHOLD_BYTES = 8192;

/** Grace period after SIGTERM before SIGKILL on cancellation/timeout. */
export const MUSE_SHUTDOWN_GRACE_MS = 10_000;
