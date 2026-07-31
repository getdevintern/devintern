/**
 * Docker Sandboxes provider (the standalone `sbx` CLI).
 *
 * Docker removed the `docker sandbox` CLI plugin; Docker Sandboxes now ships
 * as its own `sbx` binary (`brew install docker/tap/sbx`, `winget install
 * Docker.sbx`). Wrapping is a three-step flow, mirroring the smolvm provider
 * (verified against sbx v0.35.0):
 *
 *   1. `sbx create --name X <agent> <workingDir>` boots the microVM with the
 *      working dir mounted as the workspace at its host path. Runs inside
 *      {@link wrapCommand} because policy rules and `sbx exec` both need an
 *      existing sandbox.
 *   2. The policy's network settings become per-sandbox rules ("open" →
 *      `sbx policy allow network --sandbox X '**'`, an allowlist → one rule
 *      per domain). Scoped rules leave the user's global `sbx policy init`
 *      choice untouched and die with the sandbox.
 *   3. The returned command is `sbx exec X -- <agent> [args...]`, which
 *      starts in the workspace dir and — unlike `sbx run`, which is
 *      TTY-oriented and does not relay agent stdout through a pipe —
 *      streams output and exit codes to the caller.
 *
 * Structural notes:
 *
 * - Only agents pre-installed in the guest are supported, so
 *   {@link supportsHarness} restricts wrapping to that allowlist. The
 *   host-resolved executable path is ignored — the agent binary lives inside
 *   the VM and is addressed by name (`claude`, not `claude-code`).
 * - The sandbox outlives the `sbx` client process (killing the client does
 *   not stop the VM), so {@link cleanup} removes it explicitly by name.
 * - `sbx` requires a Docker sign-in (`sbx login`); detection probes `sbx ls`,
 *   which fails while signed out. (On native Linux — AUR docker-sbx, local
 *   sandboxd — `sbx ls` works without a sign-in.)
 * - One-time setup before the first run: `sbx policy init
 *   <allow-all|balanced|deny-all>` (runs fail with that exact hint until
 *   done) and `sbx secret set anthropic` for in-guest agent auth. Not
 *   detection-gated: policy state is not per-user, so there is no reliable
 *   probe, and the run-time errors are already actionable.
 *
 * Workspace selection follows the CLI's working directory, which callers set
 * via the spawn `cwd`. Host paths outside the workspace — notably the
 * `/tmp/devintern-*` worktrees and output dirs — are not part of the mounted
 * workspace, so wrapping refuses working directories under the OS tmpdir.
 */

import { spawnSync } from "child_process";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { findInPath } from "../../resolver.js";
import { probeCommand, unsupportedPlatform } from "../probe.js";
import type { SandboxDetection, SandboxPolicy, SandboxProvider, WrappedCommand } from "../types.js";

/** DevIntern harness name → agent name understood by `sbx run`. */
const SBX_AGENT_NAMES: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor",
  gemini: "gemini",
  opencode: "opencode",
};

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker";
  readonly displayName = "Docker Sandboxes (microVM)";
  // Explicit-only: detection can pass (sbx installed + signed in) while a
  // run still fails predictably without the per-user guest-agent secret
  // (`sbx secret set anthropic`) — `auto` never picks a provider whose
  // failure is foreseeable at selection time. Opt in with
  // AGENT_SANDBOX=docker after completing the sbx setup.
  readonly priority = 0;
  readonly docsUrl = "https://docs.docker.com/ai/sandboxes/";

  async detect(): Promise<SandboxDetection> {
    const platform = unsupportedPlatform();
    if (platform) return platform;

    const path = findInPath("sbx");
    if (!path) {
      return {
        available: false,
        reason:
          "sbx (Docker Sandboxes) not found on PATH. Install: " +
          (process.platform === "linux"
            ? '"sudo apt-get install docker-sbx" (Docker\'s repo; Arch: AUR docker-sbx) '
            : '"brew install docker/tap/sbx" ') +
          "— note the old docker-sandbox CLI plugin was removed",
      };
    }
    // `sbx ls` exits non-zero while signed out ("Not authenticated to Docker")
    // and when the sandbox daemon is unusable — both make the provider
    // unusable for a run, so surface them at detection time.
    if (probeCommand(path, ["ls"]) === null) {
      return {
        available: false,
        reason: "sbx found, but not usable — sign in with 'sbx login' (or run 'sbx diagnose')",
      };
    }
    return {
      available: true,
      version: probeCommand(path, ["version"])?.replace(/^sbx version:\s*/, "") ?? undefined,
    };
  }

  supportsHarness(harnessName: string): boolean {
    return harnessName in SBX_AGENT_NAMES;
  }

  wrapCommand(_path: string, args: readonly string[], policy: SandboxPolicy): WrappedCommand {
    const harnessName = policy.harnessName ?? "claude-code";
    const sbxAgent = SBX_AGENT_NAMES[harnessName];
    if (!sbxAgent) {
      throw new Error(
        `Docker Sandboxes does not support the "${harnessName}" harness. ` +
          `Supported: ${Object.keys(SBX_AGENT_NAMES).join(", ")}. ` +
          "Use AGENT_SANDBOX=nono or AGENT_SANDBOX=srt for other harnesses.",
      );
    }

    // realpathSync: macOS reports /tmp cwds canonicalized as /private/tmp,
    // and tmpdir() itself may be a symlink — compare canonical forms.
    let canonicalWorkingDir = policy.workingDir;
    let canonicalTmp = tmpdir();
    try {
      canonicalWorkingDir = realpathSync(policy.workingDir);
      canonicalTmp = realpathSync(tmpdir());
    } catch {
      // fall back to the raw paths
    }
    if (
      canonicalWorkingDir.startsWith(canonicalTmp) ||
      canonicalWorkingDir.startsWith("/tmp/") ||
      canonicalWorkingDir.startsWith("/private/tmp/")
    ) {
      throw new Error(
        `Docker Sandboxes cannot sync the working directory "${policy.workingDir}" ` +
          "(host tmp paths are not part of the mounted workspace). " +
          "Use AGENT_SANDBOX=nono or AGENT_SANDBOX=srt for worktree runs, or move " +
          "DEVINTERN_OUTPUT_DIR out of /tmp.",
      );
    }

    const sandboxName = `devintern-${process.pid}-${Date.now()}`;
    this.createSandbox(sbxAgent, sandboxName, canonicalWorkingDir);
    this.applyNetworkPolicy(sandboxName, policy);

    return {
      path: "sbx",
      args: ["exec", sandboxName, "--", sbxAgent, ...args],
      cleanup: async () => {
        // Best-effort: the sandbox may already be gone, or the run may have
        // failed before it was created.
        probeCommand("sbx", ["rm", "--force", sandboxName]);
      },
    };
  }

  /**
   * Boot the sandbox so policy rules and `sbx exec` have a target.
   * Overridable so tests can assert argv without booting a microVM.
   */
  protected createSandbox(sbxAgent: string, sandboxName: string, workingDir: string): void {
    // First creation pulls the agent template image (minutes).
    const create = spawnSync("sbx", ["create", "--name", sandboxName, sbxAgent, workingDir], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 15 * 60_000,
      env: process.env,
    });
    if (create.error || create.status !== 0) {
      const detail = create.error?.message ?? create.stderr?.trim() ?? `exit ${create.status}`;
      throw new Error(`sbx failed to create sandbox "${sandboxName}": ${detail}`);
    }
  }

  /**
   * Translate the policy's network settings into per-sandbox sbx rules.
   *
   * Best-effort: rule failures are not fatal — the global policy (set via
   * `sbx policy init`) still applies, and a blocked domain surfaces in the
   * agent's own output with sbx's actionable "Blocked by network policy"
   * error. Note an allowlist is additive over the global policy: sbx scoped
   * rules can only allow, so the global mode's own allows stay in effect.
   * Overridable for tests.
   */
  protected applyNetworkPolicy(sandboxName: string, policy: SandboxPolicy): void {
    const domains = policy.network === "open" ? ["**"] : policy.network.allowedDomains;
    if (domains.length === 0) return;
    probeCommand("sbx", [
      "policy",
      "allow",
      "network",
      "--sandbox",
      sandboxName,
      domains.join(","),
    ]);
  }
}
