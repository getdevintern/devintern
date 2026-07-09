/**
 * Core types for the agent harness abstraction.
 */

export interface AgentRunOptions {
  /** Maximum conversation turns (if supported by the agent). */
  maxTurns?: number;
  /** Skip permission prompts (if supported). */
  skipPermissions?: boolean;
  /** Model override, format is agent-specific. */
  model?: string;
  /**
   * Absolute path to the directory the agent should operate in.
   *
   * Most harnesses inherit the working directory from the spawned process's
   * `cwd`, but some (e.g. opencode) ignore it and default to `$HOME` unless a
   * directory is passed explicitly via a CLI flag. Harnesses that need it emit
   * the appropriate flag; harnesses that honor `cwd` ignore this option.
   */
  workingDir?: string;
  /** Suppress non-essential console output. */
  silent?: boolean;
  /** Enable verbose logging. */
  verbose?: boolean;
  /** How to feed the prompt to the agent. */
  inputMethod?: "arg" | "stdin";
  /** Called with each stderr chunk as the agent runs (for live status updates). */
  onStderr?: (chunk: string) => void;
}

export interface AgentRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when CLI output indicates the agent hit a max-turns limit. */
  maxTurnsReached: boolean;
}

/**
 * Abstraction over a specific AI agent CLI (Claude Code, Opencode, Codex, etc.).
 */
export interface AgentHarness {
  /** Machine-readable identifier, e.g. "claude-code" or "opencode". */
  readonly name: string;
  /** Human-readable name, e.g. "Claude Code". */
  readonly displayName: string;
  /** Default executable name or path. */
  readonly defaultPath: string;
  /**
   * Build CLI arguments for the given run options.
   *
   * Does not include the prompt; runners append the prompt separately.
   *
   * @param options - Per-run flags (model, permissions, turns, etc.).
   * @returns Argument vector passed to the agent executable before the prompt.
   */
  buildArgs(options: AgentRunOptions): string[];
  /**
   * If set, the runner passes the prompt as this flag instead of as a
   * positional argument (e.g. `--prompt "text"` rather than just `"text"`).
   * Use this when the CLI expects the prompt as a flag value.
   */
  readonly promptFlag?: string;
}

export interface ResolvedHarness {
  harness: AgentHarness;
  /** Resolved executable path. */
  path: string;
}
