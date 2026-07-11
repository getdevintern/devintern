/**
 * Placeholder harnesses for future agents.
 *
 * To add a new harness:
 * 1. Create a new file in this directory (e.g. `codex.ts`).
 * 2. Implement the `AgentHarness` interface.
 * 3. Export it from `src/index.ts` and register it in `src/registry.ts`.
 */

export { AntigravityHarness } from "./antigravity.js";
export { ClaudeCodeHarness } from "./claude-code.js";
export { ClineHarness } from "./cline.js";
export { CodexHarness } from "./codex.js";
export { CursorHarness } from "./cursor.js";
export { DeepSeekHarness } from "./deepseek.js";
/** @deprecated Use {@link AntigravityHarness}. Re-exports AntigravityHarness. */
export { GeminiHarness } from "./gemini.js";
export { GooseHarness } from "./goose.js";
export { GrokHarness } from "./grok.js";
export { KiloCodeHarness } from "./kilo-code.js";
export { KimiHarness } from "./kimi.js";
export { OpencodeHarness } from "./opencode.js";
export { PiHarness } from "./pi.js";
export { QwenCodeHarness } from "./qwen.js";
