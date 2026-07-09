/**
 * Harness registry.  New harnesses can be registered at runtime
 * or by editing this file.
 */

import type { AgentHarness } from "./types.js";
import {
  ClaudeCodeHarness,
  ClineHarness,
  CodexHarness,
  CursorHarness,
  GeminiHarness,
  GooseHarness,
  KiloCodeHarness,
  KimiHarness,
  OpencodeHarness,
  PiHarness,
  QwenCodeHarness,
} from "./harnesses/index.js";

const registry = new Map<string, AgentHarness>();

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
 * @param name - Harness identifier (e.g. `"claude-code"`).
 * @returns The harness, or `undefined` if not registered.
 */
export function getHarness(name: string): AgentHarness | undefined {
  return registry.get(name);
}

/**
 * Return every harness currently registered in the global registry.
 *
 * @returns A snapshot of all registered harness instances.
 */
export function listHarnesses(): AgentHarness[] {
  return Array.from(registry.values());
}

// Register built-in harnesses ------------------------------------------------
registerHarness(new ClaudeCodeHarness());
registerHarness(new ClineHarness());
registerHarness(new CodexHarness());
registerHarness(new CursorHarness());
registerHarness(new GeminiHarness());
registerHarness(new GooseHarness());
registerHarness(new KiloCodeHarness());
registerHarness(new KimiHarness());
registerHarness(new OpencodeHarness());
registerHarness(new PiHarness());
registerHarness(new QwenCodeHarness());
