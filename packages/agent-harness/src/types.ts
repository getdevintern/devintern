/**
 * Core types for the agent harness abstraction.
 */

/**
 * How the agent should run relative to workspace mutation.
 *
 * - `default` — full execution path (implementation). Permission-skipping
 *   follows `skipPermissions` as today.
 * - `plan` — plan-focused behavior defined by the agent CLI (explore + draft a
 *   plan). Where the CLI enforces it, source files are not mutated.
 * - `readonly` — no workspace file mutations, where the CLI can enforce that.
 *
 * Prefer real CLI enforcement only. Harnesses that cannot enforce a mode must
 * report it as unsupported and fail closed when that mode is requested.
 */
export type AgentRunMode = "default" | "plan" | "readonly";

export interface AgentRunOptions {
  /** Maximum conversation turns (if supported by the agent). */
  maxTurns?: number;
  /** Skip permission prompts (if supported). Ignored when `mode` is plan/readonly. */
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
  /**
   * Execution mode. Defaults to `"default"` (full implementation).
   * Constrained modes require harness support; runners fail closed otherwise.
   */
  mode?: AgentRunMode;
  /**
   * Extra tools to allow on top of a constrained mode's default toolset,
   * using the harness's own tool naming (e.g. Claude Code `mcp__notion` to
   * allow a whole MCP server, or `mcp__figma__get_design_context` for a
   * single tool). Only honored in plan/readonly mode by harnesses with a
   * native allowlist flag (currently claude-code); others ignore it.
   *
   * Caution: allowing a whole MCP server also allows its write tools — the
   * mode then only guarantees no direct workspace file edits, not absence of
   * MCP-side effects. Prefer per-tool entries where possible.
   */
  allowedTools?: readonly string[];
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
   * Constrained modes this harness can enforce via native CLI flags.
   * Empty / omitted means only `"default"` is supported.
   */
  readonly supportedModes?: readonly Exclude<AgentRunMode, "default">[];
  /**
   * Whether this harness's constrained modes still allow unrestricted
   * network and MCP tool use (web search, web fetch, MCP servers).
   *
   * Omitted / false means constrained modes may deny external tools — e.g.
   * Codex's read-only sandbox disables network entirely, and Claude Code's
   * plan permission mode denies MCP tools without a read-only annotation
   * (fatal in non-interactive runs). Callers whose agents need web/MCP
   * access must skip constrained modes unless this is true.
   */
  readonly constrainedModeAllowsExternalTools?: boolean;
  /**
   * Build CLI arguments for the given run options.
   *
   * Does not include the prompt; runners append the prompt separately.
   * When `options.mode` is plan/readonly, must not emit write/YOLO flags.
   *
   * @param options - Per-run flags (model, permissions, turns, mode, etc.).
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
