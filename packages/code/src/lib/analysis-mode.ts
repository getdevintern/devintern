/**
 * Read-only mode policy for internal analysis-only agent spawns
 * (clarity check, story point estimation).
 *
 * These runs only need to read the repo and emit JSON on stdout, so they use
 * the harness's native read-only enforcement when available — with a one-shot
 * fallback to the default unattended path when the constrained run fails,
 * because a read-only-mode incompatibility (e.g. an older agent CLI that
 * rejects the mode flag, or a CLI that returns empty output under it) must
 * degrade to pre-existing behavior rather than break analysis for that user.
 */

import {
  isConstrainedMode,
  isModeSupported,
  type AgentHarness,
  type AgentRunOptions,
} from "@devintern/agent-harness";

/**
 * Thrown by analysis runs when a constrained-mode agent produced unusable
 * output (e.g. unparseable or empty stdout with exit 0 — observed on grok
 * plan mode). Signals {@link runAnalysisWithFallback} to retry in default
 * mode before the caller posts failure comments or proceeds degraded.
 */
export class ReadonlyAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadonlyAnalysisError";
  }
}

/**
 * Run options for analysis-only spawns: native read-only mode when the
 * harness supports it (never combined with permission-skip), the unattended
 * default otherwise.
 *
 * Known tradeoff: constrained modes reduce the toolset beyond file writes on
 * some harnesses — cursor (ask mode) and opencode (plan agent) lose shell
 * entirely, claude-code keeps only read-only bash, and MCP tools are
 * restricted on most (see per-harness doc comments in
 * packages/agent-harness/src/harnesses/). Acceptable here because these
 * prompts are mostly local-repo reads. claude-code re-allows WebFetch and
 * WebSearch so linked docs in task descriptions stay reachable, and
 * AGENT_ANALYSIS_ALLOWED_TOOLS (comma-separated, harness tool naming — e.g.
 * `mcp__notion,mcp__figma__get_design_context`) lets users extend the
 * allowlist to MCP servers they enabled for their harness.
 */
export function analysisRunOptions(harness: AgentHarness, maxTurns: number): AgentRunOptions {
  if (isModeSupported(harness, "readonly")) {
    const allowedTools = (process.env.AGENT_ANALYSIS_ALLOWED_TOOLS ?? "")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);
    return {
      maxTurns,
      mode: "readonly",
      skipPermissions: false,
      workingDir: process.cwd(),
      ...(allowedTools.length > 0 ? { allowedTools } : {}),
    };
  }
  return defaultAnalysisRunOptions(maxTurns);
}

/** The pre-DEV-24 unattended path used when read-only mode is unavailable or failed. */
export function defaultAnalysisRunOptions(maxTurns: number): AgentRunOptions {
  return { maxTurns, skipPermissions: true, workingDir: process.cwd() };
}

/**
 * Whether a failed constrained-mode analysis run should be retried in
 * default mode.
 *
 * Retry on failures plausibly caused by the mode itself: nonzero exits
 * (e.g. an agent CLI rejecting the mode flag at startup) and
 * {@link ReadonlyAnalysisError} (unusable output). Never retry failures the
 * default path would hit identically or that must abort: timeouts (a retry
 * doubles an already-long wait), missing CLI, and account-global usage
 * limits.
 */
export function shouldRetryInDefaultMode(error: unknown): boolean {
  if (error instanceof ReadonlyAnalysisError) {
    return true;
  }
  if (error instanceof Error && error.name === "UsageLimitError") {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message) || /not found/i.test(message)) {
    return false;
  }
  return true;
}

/**
 * Execute an analysis run in read-only mode with a one-shot default-mode
 * fallback.
 *
 * @param harness - Resolved agent harness.
 * @param maxTurns - Turn cap for the analysis run.
 * @param run - Executes the analysis with the given options; called once,
 *   or twice when the first constrained attempt fails retriably.
 */
export async function runAnalysisWithFallback<T>(
  harness: AgentHarness,
  maxTurns: number,
  run: (options: AgentRunOptions) => Promise<T>,
): Promise<T> {
  const options = analysisRunOptions(harness, maxTurns);
  if (!isConstrainedMode(options.mode)) {
    return run(options);
  }
  try {
    return await run(options);
  } catch (error) {
    if (!shouldRetryInDefaultMode(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Read-only analysis run failed (${message}); retrying once in default mode`);
    return run(defaultAnalysisRunOptions(maxTurns));
  }
}
