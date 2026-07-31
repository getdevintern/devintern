/**
 * Native sandbox provider: use the harness's own built-in OS sandbox.
 *
 * Two harnesses ship real OS-level sandboxing; this provider turns it on
 * and translates the DevIntern policy into each harness's config surface
 * instead of wrapping the process externally:
 *
 * - claude-code: native Bash-tool sandbox (Seatbelt/bubblewrap), configured
 *   via a generated settings file passed with `--settings`. Scope caveat:
 *   it confines Bash commands and their children, not the agent's own file
 *   Write/Edit tools (those go through the permission system we disable).
 * - codex: `--sandbox workspace-write` (already emitted by the codex
 *   harness) plus `-c sandbox_workspace_write.writable_roots=[...]` config
 *   overrides for the extra writable paths.
 *
 * Antigravity (the Gemini CLI successor) is deliberately not wired: its
 * `--sandbox` confines shell commands only (agent file tools bypass it),
 * exposes no writable-roots or network config, and under
 * --dangerously-skip-permissions the model's bypassSandbox retry is
 * auto-approved, voiding the boundary (antigravity-cli#36, #45). The
 * policy contract cannot be honored; revisit if those issues land.
 *
 * Zero install and no nesting hazards, so it has the highest auto priority.
 * The trade-off versus the external wrappers: the boundary is configured
 * and enforced inside the harness process rather than by the parent, and
 * (for claude-code) covers a narrower scope. Users who want the stronger
 * parent-enforced guarantee choose nono/srt explicitly.
 */

import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { unsupportedPlatform } from "../probe.js";
import type { SandboxDetection, SandboxPolicy, SandboxProvider, WrappedCommand } from "../types.js";

/** Harnesses with a usable built-in OS sandbox. */
const NATIVE_CAPABLE = ["claude-code", "codex"];

export class NativeSandboxProvider implements SandboxProvider {
  readonly name = "native";
  readonly displayName = "Harness native sandbox";
  readonly priority = 40; // above the external wrappers: zero install, no nesting
  readonly docsUrl =
    "https://devintern.com/docs/code/configuration#claude-code-native-sandbox-details";

  async detect(): Promise<SandboxDetection> {
    const platform = unsupportedPlatform();
    if (platform) return platform;
    // Nothing to install: the sandbox ships inside the harness CLI itself.
    return {
      available: true,
      version: `built into ${NATIVE_CAPABLE.join(", ")}`,
    };
  }

  supportsHarness(harnessName: string): boolean {
    return NATIVE_CAPABLE.includes(harnessName);
  }

  wrapCommand(path: string, args: readonly string[], policy: SandboxPolicy): WrappedCommand {
    const harnessName = policy.harnessName ?? "claude-code";
    switch (harnessName) {
      case "claude-code":
        return this.wrapClaudeCode(path, args, policy);
      case "codex":
        return this.wrapCodex(path, args, policy);
      default:
        throw new Error(
          `The "${harnessName}" harness has no built-in sandbox. ` +
            `Native sandboxing supports: ${NATIVE_CAPABLE.join(", ")}. ` +
            "Use AGENT_SANDBOX=nono or AGENT_SANDBOX=srt for other harnesses.",
        );
    }
  }

  /**
   * Enable Claude Code's Bash-tool sandbox via a per-run settings file.
   *
   * `allowUnsandboxedCommands: false` closes the dangerouslyDisableSandbox
   * escape hatch, and `failIfUnavailable: true` makes a missing dependency a
   * hard failure instead of a silent unsandboxed fallback — matching the
   * resolver's "explicitly requested isolation never silently degrades" rule.
   *
   * Network must be granted explicitly: the sandbox default is deny-with-
   * prompt, and in `-p` print mode there is nobody to approve the prompt —
   * with the escape hatch also closed, network commands would hard-fail.
   * So the "open" policy is expressed as `allowedDomains: ["*"]`, and the
   * pieces agent runs rely on are pre-allowed: localhost binding (dev
   * servers, Playwright CDP) and the ssh-agent socket (git push over ssh).
   * Commands the sandbox cannot run at all (per upstream docs: docker;
   * Go CLIs like gh fail TLS under Seatbelt) are excluded so they run
   * outside it rather than hard-failing — exactly today's (unsandboxed)
   * behavior for those two commands, and no worse.
   */
  private wrapClaudeCode(
    path: string,
    args: readonly string[],
    policy: SandboxPolicy,
  ): WrappedCommand {
    const sshAgentSocket = process.env.SSH_AUTH_SOCK;
    const settings = {
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
        excludedCommands: ["docker *", "gh *"],
        filesystem: {
          allowWrite: policy.writablePaths,
        },
        network: {
          allowedDomains: policy.network === "open" ? ["*"] : policy.network.allowedDomains,
          allowLocalBinding: true,
          ...(sshAgentSocket ? { allowUnixSockets: [sshAgentSocket] } : {}),
        },
      },
    };
    const settingsDir = mkdtempSync(join(tmpdir(), "devintern-native-sandbox-"));
    const settingsFile = join(settingsDir, "sandbox-settings.json");
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

    return { path, args: [...args, "--settings", settingsFile] };
  }

  /**
   * Codex already runs with `--sandbox workspace-write` (the codex harness
   * emits it alongside skip-permissions); ensure it is present and widen the
   * writable roots to the policy's extra paths via config overrides.
   */
  private wrapCodex(path: string, args: readonly string[], policy: SandboxPolicy): WrappedCommand {
    const outArgs = [...args];
    if (!outArgs.includes("--sandbox")) {
      outArgs.unshift("--sandbox", "workspace-write");
    }
    const extraRoots = policy.writablePaths.filter((p) => p !== policy.workingDir);
    if (extraRoots.length > 0) {
      outArgs.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(extraRoots)}`);
    }
    return { path, args: outArgs };
  }
}
