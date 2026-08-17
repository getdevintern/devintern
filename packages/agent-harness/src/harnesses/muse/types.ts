/**
 * Muse Code harness-specific types.
 */

/** Reasoning effort levels supported by Muse Code headless runs. */
export type MuseReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "ultra";

/** Muse-specific run options (via {@link AgentRunOptions.muse}). */
export interface MuseHarnessOptions {
  /** Override model reasoning depth (`--reasoning-effort`). */
  reasoningEffort?: MuseReasoningEffort;
  /** Sandbox network mode (`--sandbox-network`). */
  sandboxNetwork?: string;
  /**
   * Disable OS sandbox (`--disable-sandbox`). Requires {@link yolo} — disabling
   * the sandbox without explicit `--yolo` is not allowed.
   */
  disableSandbox?: boolean;
  /**
   * Skip approval prompts while keeping sandbox (`--disable-approval`).
   * When `skipPermissions` is true and `yolo` is not set, this defaults to true.
   */
  disableApproval?: boolean;
  /**
   * Disable approval and sandbox (`--yolo`). Must be explicitly enabled;
   * never implied by `skipPermissions`.
   */
  yolo?: boolean;
  /** Trust workspace rules/skills (`--trust-workspace`). Implied by `--yolo`. */
  trustWorkspace?: boolean;
  /** Isolate subagent worktrees (`--subagent-worktree-isolation`). */
  subagentWorktreeIsolation?: boolean;
  /** Continue an existing session (`--session-id`). */
  sessionId?: string;
  /** Allow workspace mismatch when resuming (`--allow-workspace-switch`). */
  allowWorkspaceSwitch?: boolean;
  /** Do not persist session log (`--no-session-log`). */
  noSessionLog?: boolean;
}

/** Normalized Muse process outcome (distinct from work success). */
export type MuseExitState =
  | "completed"
  | "failed"
  | "cancelled"
  | "step_limit"
  | "usage_error"
  | "interrupted"
  | "sandbox_unavailable"
  | "invalid_config"
  | "binary_missing";

/** Parsed JSONL event from `muse exec --json`. */
export interface MuseJsonlEvent {
  /** Raw parsed object when JSON was valid. */
  raw: Record<string, unknown>;
  /** Event type string when present. */
  type?: string;
}

/** Result of incremental JSONL parsing. */
export interface MuseJsonlParseState {
  /** Human-readable text extracted from known event shapes. */
  textParts: string[];
  /** All parsed events (including unknown types). */
  events: MuseJsonlEvent[];
  /** Malformed line diagnostics (no secret content). */
  parseErrors: string[];
  /** Whether a step-limit condition was observed in the stream. */
  stepLimitReached: boolean;
}

/** Extended result for Muse runs. */
export interface MuseRunResult {
  /** Human-readable text extracted from JSONL events (never raw JSONL). */
  stdout: string;
  stderr: string;
  exitCode: number;
  maxTurnsReached: boolean;
  exitState: MuseExitState;
  /** Extracted assistant text (same as stdout for downstream compatibility). */
  normalizedText: string;
  /** Raw stdout from the Muse process (JSONL when `--json` is used). */
  rawStdout: string;
  events: MuseJsonlEvent[];
  parseErrors: string[];
  warnings: string[];
  cliVersion?: string;
}
