/**
 * Codex CLI harness.
 *
 * CLI: codex exec --skip-git-repo-check [--sandbox workspace-write -c 'approval_policy="never"' <network config>] [--model <model>] [prompt]
 *
 * Uses `codex exec` (non-interactive mode) so the agent runs without
 * launching the TUI.
 *
 * Modes:
 * - plan / readonly → `--sandbox read-only` (OS-enforced; no file writes)
 * - Default + skipPermissions → `--sandbox workspace-write` with approval and
 *   network/local-binding config overrides
 *
 * Constrained-mode caveats (per OpenAI approvals/security docs, 2026-07):
 * shell still works in the read-only sandbox (filesystem is read-only at the
 * OS level), but network is disabled inside it. MCP servers are spawned
 * outside the sandbox and are NOT restricted by it — read-only mode is not a
 * guarantee against MCP-side effects.
 *
 * @see https://platform.openai.com/docs/codex
 */

import { effectiveSkipPermissions, isConstrainedMode, assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export type CodexNetworkPolicy = "open" | { allowedDomains: readonly string[] };

const CODEX_NETWORK_CONFIG_PREFIXES = [
  "sandbox_workspace_write.network_access=",
  "features.network_proxy.enabled=",
  "features.network_proxy.allow_local_binding=",
  "features.network_proxy.domains=",
] as const;

/**
 * Build Codex config overrides for an autonomous workspace-write run.
 *
 * Codex keeps network access off by default in `workspace-write`. DevIntern's
 * default sandbox policy is network-open, and agent workflows need both
 * external services and localhost dev servers, so express that policy through
 * Codex's network proxy rather than falling back to full filesystem access.
 */
export function buildCodexNetworkArgs(network: CodexNetworkPolicy = "open"): string[] {
  const domains = network === "open" ? ["*"] : network.allowedDomains;
  const domainRules = domains.map((domain) => `${JSON.stringify(domain)} = "allow"`).join(", ");

  return [
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    "features.network_proxy.enabled=true",
    "-c",
    "features.network_proxy.allow_local_binding=true",
    "-c",
    `features.network_proxy.domains={ ${domainRules} }`,
  ];
}

/**
 * Replace network-related Codex config overrides on an invocation.
 *
 * Native sandbox wrapping may receive args that already came from
 * {@link CodexHarness.buildArgs}; filtering first makes the outer policy the
 * effective one without accumulating duplicate `-c` values.
 */
export function applyCodexNetworkArgs(
  args: readonly string[],
  network: CodexNetworkPolicy,
): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (
      arg === "-c" &&
      typeof value === "string" &&
      CODEX_NETWORK_CONFIG_PREFIXES.some((prefix) => value.startsWith(prefix))
    ) {
      index += 1;
      continue;
    }
    if (typeof arg === "string") {
      filtered.push(arg);
    }
  }
  filtered.push(...buildCodexNetworkArgs(network));
  return filtered;
}

export class CodexHarness implements AgentHarness {
  readonly name = "codex";
  readonly displayName = "Codex";
  readonly defaultPath = "codex";
  readonly supportedModes = ["plan", "readonly"] as const;
  /** Codex `exec` accepts images via `-i` after the prompt. */
  readonly imageInput = "native" as const;

  /**
   * Build trailing `-i` flags for native image attachment.
   *
   * Must be appended **after** the prompt in `codex exec` mode.
   *
   * @param paths - Absolute image file paths.
   */
  buildImageArgs(paths: readonly string[]): string[] {
    const args: string[] = [];
    for (const path of paths) {
      if (path.trim()) {
        args.push("-i", path);
      }
    }
    return args;
  }

  /**
   * Build `codex exec` flags for non-interactive execution.
   *
   * @param options - Supports `mode`, `skipPermissions` (sandbox + approval), and `model`.
   * @returns Args starting with `exec`; prompt is appended as a positional argument.
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    // The embedding application owns cwd selection and any repository gate.
    // Codex's interactive trust check cannot be answered in `exec` mode and can
    // reject otherwise valid repositories that have not previously been opened
    // in Codex, so bypass it for every non-interactive harness invocation.
    const args: string[] = ["exec", "--skip-git-repo-check"];

    if (isConstrainedMode(options.mode)) {
      // Hard read-only sandbox for both plan and readonly (Codex has no separate plan flag).
      args.push("--sandbox", "read-only", "-c", 'approval_policy="never"');
    } else if (effectiveSkipPermissions(options)) {
      args.push(
        "--sandbox",
        "workspace-write",
        "-c",
        'approval_policy="never"',
        ...buildCodexNetworkArgs(),
      );
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    // Codex does not currently support --max-turns in exec mode.
    // If it adds support in the future, uncomment the following:
    // if (options.maxTurns !== undefined) {
    //   args.push("--max-turns", String(options.maxTurns));
    // }

    return args;
  }
}
