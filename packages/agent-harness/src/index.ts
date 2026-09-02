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
export type {
  AgentHarness,
  AgentRunMode,
  AgentRunOptions,
  AgentRunResult,
  ResolvedHarness,
  StructuredOutputResult,
} from "./types.js";

// Run modes (plan / readonly) and capability checks
export {
  UnsupportedAgentModeError,
  assertModeSupported,
  constrainedModeAllowsExternalTools,
  effectiveSkipPermissions,
  getSupportedModes,
  isConstrainedMode,
  isModeSupported,
  type ConstrainedAgentRunMode,
} from "./modes.js";

// Registry
export { registerHarness, getHarness, listHarnesses, HARNESS_ALIASES } from "./registry.js";

// Prompt argument construction
export { buildPromptArgs } from "./prompt-args.js";

// Attachment helpers (path injection + native image args)
export {
  appendAttachmentPathsToPrompt,
  attachmentKindForPath,
  isImagePath,
  preparePromptWithAttachments,
  type AttachmentKind,
  type PromptAttachment,
} from "./attachments.js";

// Resolver
export {
  resolveHarness,
  findInPath,
  getHarnessCliCommand,
  isHarnessCliAvailable,
  isHarnessInstalled,
  listInstalledHarnesses,
  resolveExecutablePath,
  resolveExecutablePathStrict,
  resolveExecutablePathWithRetry,
  type HarnessInstallOptions,
  type HarnessResolutionOptions,
  type ListInstalledHarnessesOptions,
  type ResolveWithRetryOptions,
} from "./resolver.js";

// Built-in harnesses
export { AntigravityHarness } from "./harnesses/antigravity.js";
export { ClaudeCodeHarness } from "./harnesses/claude-code.js";
export { ClineHarness } from "./harnesses/cline.js";
export { CodexHarness } from "./harnesses/codex.js";
export { CursorHarness } from "./harnesses/cursor.js";
export { DeepSeekHarness } from "./harnesses/deepseek.js";
/** @deprecated Use {@link AntigravityHarness}. Re-exports AntigravityHarness. */
export { GeminiHarness } from "./harnesses/gemini.js";
export { GooseHarness } from "./harnesses/goose.js";
export { GrokHarness } from "./harnesses/grok.js";
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

// Sandbox providers (opt-in OS-level isolation for the agent subprocess)
export type {
  ResolvedSandbox,
  SandboxDetection,
  SandboxPolicy,
  SandboxProvider,
  WrappedCommand,
} from "./sandbox/types.js";
export {
  registerSandboxProvider,
  getSandboxProvider,
  listSandboxProviders,
} from "./sandbox/registry.js";
export { resolveSandbox, type SandboxResolutionOptions } from "./sandbox/resolver.js";
export { detectSandboxProviders, type DetectedSandboxProvider } from "./sandbox/detect.js";
export { probeCommand, unsupportedPlatform } from "./sandbox/probe.js";
export { NativeSandboxProvider } from "./sandbox/providers/native.js";
export { NonoSandboxProvider } from "./sandbox/providers/nono.js";
export { SrtSandboxProvider } from "./sandbox/providers/srt.js";
export { DockerSandboxProvider } from "./sandbox/providers/docker.js";
export { SmolvmSandboxProvider } from "./sandbox/providers/smolvm.js";
export {
  spawnAgent,
  applyNestingGuard,
  buildDefaultSandboxPolicy,
  type SpawnAgentOptions,
  type SpawnedAgent,
} from "./spawn-agent.js";

// Max-turns detection
export { detectMaxTurnsReached, findMaxTurnsReachedLine } from "./detect-max-turns.js";

// Usage/rate-limit detection
export {
  UsageLimitError,
  detectUsageLimit,
  resetHintToMs,
  type UsageLimitResult,
} from "./detect-usage-limit.js";

// Incomplete implementation detection
export {
  detectIncompleteImplementation,
  type IncompleteImplementationResult,
} from "./detect-incomplete-implementation.js";

// Open-question detection (agent blocked on user input)
export { detectOpenQuestions, type OpenQuestionsResult } from "./detect-open-questions.js";

// Structured (JSON) output
export {
  UnsupportedStructuredOutputError,
  assertStructuredOutputSupported,
  parseStructuredOutput,
} from "./structured-output.js";

// Per-harness structured (JSON) envelope schemas (reply + usage/cost stats)
export {
  extractHarnessEventText,
  extractHarnessStructuredReply,
  type HarnessStructuredReply,
  type StructuredRunStats,
  type StructuredTokenUsage,
} from "./structured-envelope.js";
