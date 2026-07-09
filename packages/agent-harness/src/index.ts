/**
 * @devintern/agent-harness
 *
 * Agent harness abstraction for running AI coding agents
 * (Claude Code, Opencode, Codex, Cursor CLI, etc.).
 *
 * Adding a new harness:
 *   1. Create `src/harnesses/<name>.ts` implementing `AgentHarness`.
 *   2. Register it in `src/registry.ts`.
 *   3. Re-export it from `src/harnesses/index.ts`.
 */

// Types
export type { AgentHarness, AgentRunOptions, AgentRunResult, ResolvedHarness } from "./types.js";

// Registry
export { registerHarness, getHarness, listHarnesses } from "./registry.js";

// Resolver
export {
  resolveHarness,
  findInPath,
  resolveExecutablePath,
  resolveExecutablePathStrict,
  resolveExecutablePathWithRetry,
  type HarnessResolutionOptions,
  type ResolveWithRetryOptions,
} from "./resolver.js";

// Built-in harnesses
export { ClaudeCodeHarness } from "./harnesses/claude-code.js";
export { ClineHarness } from "./harnesses/cline.js";
export { CodexHarness } from "./harnesses/codex.js";
export { CursorHarness } from "./harnesses/cursor.js";
export { GeminiHarness } from "./harnesses/gemini.js";
export { GooseHarness } from "./harnesses/goose.js";
export { KiloCodeHarness } from "./harnesses/kilo-code.js";
export { KimiHarness } from "./harnesses/kimi.js";
export { OpencodeHarness } from "./harnesses/opencode.js";
export { PiHarness } from "./harnesses/pi.js";
export { QwenCodeHarness } from "./harnesses/qwen.js";

// Runners
export { runAgentBun } from "./runners/bun.js";
export { runAgentNode, type NodeRunnerOptions } from "./runners/node.js";

// Process-group reaper (prevents orphaned dev servers / watchers)
export { spawnReapable, reapTree } from "./process-reaper.js";

// Max-turns detection
export { detectMaxTurnsReached } from "./detect-max-turns.js";

// Usage/rate-limit detection
export { detectUsageLimit, resetHintToMs, type UsageLimitResult } from "./detect-usage-limit.js";

// Incomplete implementation detection
export {
  detectIncompleteImplementation,
  type IncompleteImplementationResult,
} from "./detect-incomplete-implementation.js";
