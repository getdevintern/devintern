/**
 * Harness registry.  New harnesses can be registered at runtime
 * or by editing this file.
 */

import type { AgentHarness } from "./types.js";
import {
  AntigravityHarness,
  ClaudeCodeHarness,
  ClineHarness,
  CodexHarness,
  CursorHarness,
  DeepSeekHarness,
  GooseHarness,
  GrokHarness,
  KiloCodeHarness,
  KimiHarness,
  OpencodeHarness,
  PiHarness,
  QwenCodeHarness,
} from "./harnesses/index.js";

const registry = new Map<string, AgentHarness>();

/**
 * Alias map: alternate harness ids → canonical registered name.
 *
 * Deprecated aliases may still resolve during a soft-deprecation window;
 * {@link resolveHarness} emits warnings for those.
 */
export const HARNESS_ALIASES: Readonly<
  Record<string, { target: string; deprecated?: boolean; warning?: string }>
> = {
  /** Binary name users often type as the harness id. */
  agy: { target: "antigravity" },
  /**
   * Google retired consumer Gemini CLI (2026-06-18) in favor of Antigravity CLI.
   * Keep accepting the old id so existing .env files keep working.
   */
  gemini: {
    target: "antigravity",
    deprecated: true,
    warning:
      "AGENT_HARNESS=gemini is deprecated: Google retired Gemini CLI (consumer access ended 2026-06-18) " +
      'in favor of Antigravity CLI (agy). Routing to harness "antigravity". ' +
      "Set AGENT_HARNESS=antigravity (or agy), install agy " +
      "(https://antigravity.google/docs/cli/install), and re-auth. " +
      "GEMINI_API_KEY is no longer used; use agy auth / ANTIGRAVITY_TOKEN as documented.",
  },
};

/**
 * Register a harness implementation for lookup by {@link getHarness}.
 *
 * @param harness - Harness instance; keyed by {@link AgentHarness.name}.
 */
export function registerHarness(harness: AgentHarness): void {
  registry.set(harness.name, harness);
}

/**
 * Look up a registered harness by its machine-readable name.
 *
 * Resolves {@link HARNESS_ALIASES} (e.g. `agy` / `gemini` → `antigravity`)
 * without emitting deprecation warnings; callers that need warnings should use
 * {@link resolveHarness}.
 *
 * @param name - Harness identifier (e.g. `"claude-code"`).
 * @returns The harness, or `undefined` if not registered.
 */
export function getHarness(name: string): AgentHarness | undefined {
  const canonical = HARNESS_ALIASES[name]?.target ?? name;
  return registry.get(canonical);
}

/**
 * Return every harness currently registered in the global registry.
 *
 * @returns A snapshot of all registered harness instances (canonical names only;
 *   aliases are not listed separately).
 */
export function listHarnesses(): AgentHarness[] {
  return Array.from(registry.values());
}

// Register built-in harnesses ------------------------------------------------
registerHarness(new AntigravityHarness());
registerHarness(new ClaudeCodeHarness());
registerHarness(new ClineHarness());
registerHarness(new CodexHarness());
registerHarness(new CursorHarness());
registerHarness(new DeepSeekHarness());
registerHarness(new GooseHarness());
registerHarness(new GrokHarness());
registerHarness(new KiloCodeHarness());
registerHarness(new KimiHarness());
registerHarness(new OpencodeHarness());
registerHarness(new PiHarness());
registerHarness(new QwenCodeHarness());
