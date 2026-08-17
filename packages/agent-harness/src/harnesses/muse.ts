/**
 * Muse Code harness.
 *
 * CLI: muse exec --json [--prompt-file <path> | <prompt>] [flags…]
 *
 * Headless runs via `muse exec` with JSONL on stdout. The dedicated
 * {@link runAgentMuse} runner handles incremental JSONL parsing, prompt-file
 * delivery, and exit-state normalization.
 *
 * Modes: Muse Code has no native plan/readonly headless modes — constrained
 * modes are unsupported (fail closed via {@link assertModeSupported}).
 *
 * Unattended default: `--disable-approval` when `skipPermissions` is true.
 * `--yolo` disables sandbox and approval and must be set explicitly via
 * `options.muse.yolo`.
 *
 * @see https://dev.meta.ai/docs/muse-code/extending#headless-and-ci
 * @see https://dev.meta.ai/docs/muse-code/configuration#launch-flags
 */

import { assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";
import { isGitWorkspace } from "./muse/git-workspace.js";
import { MUSE_EXEC_SUBCOMMAND, MUSE_JSON_FLAG } from "./muse/constants.js";
import { resolveMusePermissionFlags, validateMuseRunOptions } from "./muse/validation.js";
import type { MuseHarnessOptions } from "./muse/types.js";

export class MuseHarness implements AgentHarness {
  readonly name = "muse";
  readonly displayName = "Muse Code";
  readonly defaultPath = "muse";

  /**
   * Build `muse exec --json` flags for headless execution.
   *
   * Does not include the prompt; the Muse runner appends `--prompt-file` or a
   * positional prompt via {@link planMusePromptDelivery}.
   *
   * @param options - Supports model, maxTurns (`--max-model-steps`), workingDir,
   *   skipPermissions, and Muse-specific `options.muse` settings.
   */
  buildArgs(options: AgentRunOptions): string[] {
    validateMuseRunOptions(this, options);
    assertModeSupported(this, options.mode);

    const args: string[] = [MUSE_EXEC_SUBCOMMAND, MUSE_JSON_FLAG];
    const muse = options.muse as MuseHarnessOptions | undefined;
    const permissions = resolveMusePermissionFlags(options);

    if (options.model) {
      args.push("--model", options.model);
    }

    if (muse?.reasoningEffort) {
      args.push("--reasoning-effort", muse.reasoningEffort);
    }

    if (options.workingDir) {
      args.push("--workspace", options.workingDir);
    }

    if (muse?.sandboxNetwork) {
      args.push("--sandbox-network", muse.sandboxNetwork);
    }

    if (muse?.disableSandbox === true) {
      args.push("--disable-sandbox");
    }

    if (permissions.yolo) {
      args.push("--yolo");
    } else if (permissions.disableApproval) {
      args.push("--disable-approval");
    }

    if (permissions.trustWorkspace) {
      args.push("--trust-workspace");
    }

    if (muse?.subagentWorktreeIsolation === true) {
      args.push("--subagent-worktree-isolation");
    }

    if (muse?.sessionId) {
      args.push("--session-id", muse.sessionId);
    }

    if (muse?.allowWorkspaceSwitch === true) {
      args.push("--allow-workspace-switch");
    }

    if (options.maxTurns !== undefined) {
      args.push("--max-model-steps", String(options.maxTurns));
    }

    if (muse?.noSessionLog === true) {
      args.push("--no-session-log");
    }

    return args;
  }

  /**
   * Collect non-fatal warnings before launch (e.g. git worktree isolation).
   *
   * @param options - Run options.
   */
  collectWarnings(options: AgentRunOptions): string[] {
    const warnings: string[] = [];
    const muse = options.muse as MuseHarnessOptions | undefined;
    const permissions = resolveMusePermissionFlags(options);

    if (muse?.disableSandbox === true) {
      warnings.push(
        "Muse --disable-sandbox is enabled: OS sandbox is disabled. Use only in trusted CI environments.",
      );
    }

    if (permissions.yolo) {
      warnings.push(
        "Muse --yolo is enabled: approval prompts and OS sandbox are disabled, and the workspace is trusted.",
      );
    } else if (permissions.disableApproval) {
      warnings.push(
        "Muse --disable-approval is enabled: approval prompts are skipped (sandbox remains on).",
      );
    }

    if (
      muse?.subagentWorktreeIsolation &&
      options.workingDir &&
      !isGitWorkspace(options.workingDir)
    ) {
      warnings.push(
        "Muse --subagent-worktree-isolation requires a Git repository; Muse silently ignores this flag outside Git.",
      );
    }

    return warnings;
  }
}

/** Type guard for the Muse harness. */
export function isMuseHarness(harness: AgentHarness): harness is MuseHarness {
  return harness.name === "muse";
}
