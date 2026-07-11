/**
 * @deprecated Gemini CLI (consumer) was retired on 2026-06-18 in favor of
 * Antigravity CLI (`agy`). Use {@link AntigravityHarness} and
 * `AGENT_HARNESS=antigravity` instead. The legacy harness name `gemini` still
 * resolves to Antigravity via {@link resolveHarness} during the deprecation window.
 *
 * This module re-exports Antigravity so existing imports of `GeminiHarness` do
 * not spawn the dead `gemini` binary.
 *
 * @see https://antigravity.google/docs/cli/gcli-migration
 */

export { AntigravityHarness as GeminiHarness } from "./antigravity.js";
