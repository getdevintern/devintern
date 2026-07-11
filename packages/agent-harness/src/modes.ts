/**
 * Shared agent run modes and capability checks.
 *
 * Modes are only exposed when a harness can map them to real CLI constraints.
 * Unsupported requests fail closed via {@link assertModeSupported}.
 */

import type { AgentHarness, AgentRunMode, AgentRunOptions } from "./types.js";

/** Modes other than the default full-execution path. */
export type ConstrainedAgentRunMode = Exclude<AgentRunMode, "default">;

/**
 * True when the mode is plan or read-only (workspace must not be mutated).
 */
export function isConstrainedMode(mode?: AgentRunMode): mode is ConstrainedAgentRunMode {
  return mode === "plan" || mode === "readonly";
}

/**
 * Whether `skipPermissions` should take effect.
 *
 * Constrained modes always win: never apply YOLO / bypass flags that would
 * override plan or read-only enforcement.
 */
export function effectiveSkipPermissions(options: AgentRunOptions): boolean {
  if (isConstrainedMode(options.mode)) {
    return false;
  }
  return options.skipPermissions === true;
}

/**
 * Modes this harness can enforce natively (excludes `"default"`, which all
 * harnesses support).
 */
export function getSupportedModes(harness: AgentHarness): readonly ConstrainedAgentRunMode[] {
  return harness.supportedModes ?? [];
}

/**
 * Whether the harness natively supports the given mode.
 * `"default"` / undefined is always supported.
 */
export function isModeSupported(harness: AgentHarness, mode?: AgentRunMode): boolean {
  if (!mode || mode === "default") {
    return true;
  }
  return getSupportedModes(harness).includes(mode);
}

/**
 * Whether the harness's constrained modes keep unrestricted network and MCP
 * tool access (web search, web fetch, MCP servers).
 *
 * Spawns whose agents may need external tools (e.g. web research during task
 * generation) must only use a constrained mode when this returns true.
 */
export function constrainedModeAllowsExternalTools(harness: AgentHarness): boolean {
  return harness.constrainedModeAllowsExternalTools === true;
}

/**
 * Error thrown when a caller requests a mode the harness cannot enforce.
 */
export class UnsupportedAgentModeError extends Error {
  readonly harnessName: string;
  readonly mode: ConstrainedAgentRunMode;
  readonly supportedModes: readonly ConstrainedAgentRunMode[];

  constructor(harness: AgentHarness, mode: ConstrainedAgentRunMode) {
    const supported = getSupportedModes(harness);
    const supportedLabel = supported.length > 0 ? supported.join(", ") : "none (default only)";
    super(
      `${harness.displayName} (${harness.name}) does not support agent mode "${mode}". ` +
        `Supported constrained modes: ${supportedLabel}. ` +
        `Use a harness that enforces this mode, or omit mode for default execution.`,
    );
    this.name = "UnsupportedAgentModeError";
    this.harnessName = harness.name;
    this.mode = mode;
    this.supportedModes = supported;
  }
}

/**
 * Fail closed when a constrained mode is requested but not supported.
 *
 * @throws {UnsupportedAgentModeError} when the mode cannot be enforced
 */
export function assertModeSupported(harness: AgentHarness, mode?: AgentRunMode): void {
  if (!mode || mode === "default") {
    return;
  }
  if (!isModeSupported(harness, mode)) {
    throw new UnsupportedAgentModeError(harness, mode);
  }
}
