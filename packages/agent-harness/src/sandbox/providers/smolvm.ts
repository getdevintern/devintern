/**
 * SmolVM sandbox provider (CelestoAI/SmolVM) — explicit-only in v1.
 *
 * SmolVM runs agents inside a microVM (QEMU on macOS, Firecracker/KVM on
 * Linux) with host directories mounted read-write over 9p. The CLI has no
 * single-shot run command, so wrapping is a three-step flow (verified against
 * smolvm 0.0.28):
 *
 *   1. `smolvm <agent> start --name X --mount wd:wd --writable-mounts
 *      --no-attach` boots the VM, installs the agent in the guest, and
 *      forwards host agent credentials (~/.claude) into it. Runs inside
 *      {@link wrapCommand} because `sandbox exec` needs a booted sandbox.
 *   2. The returned command is `smolvm sandbox exec X --timeout N -- sh -lc
 *      "cd wd && <agent> args..."`. The working dir is mounted at its host
 *      path, so host-path arguments resolve unchanged inside the guest.
 *   3. `cleanup()` deletes the sandbox (`smolvm sandbox delete X`).
 *
 * Only agents pre-installed in the guest are supported (claude, codex, pi);
 * the host-resolved executable path is ignored. Priority is 0 so `auto`
 * never selects it — first boot downloads a guest image (minutes) and the
 * project is pre-1.0; users opt in with AGENT_SANDBOX=smolvm.
 */

import { spawnSync } from "child_process";
import { findInPath } from "../../resolver.js";
import { probeCommand, probeCommandOutput, unsupportedPlatform } from "../probe.js";
import type { SandboxDetection, SandboxPolicy, SandboxProvider, WrappedCommand } from "../types.js";

/** DevIntern harness name → agent binary/subcommand in the smolvm guest. */
const SMOLVM_AGENT_NAMES: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  pi: "pi",
};

/** Ceiling for a single in-guest agent run (`sandbox exec --timeout`). */
const EXEC_TIMEOUT_SECONDS = 86_400;

/** First boot may download a multi-GB guest image. */
const BOOT_TIMEOUT_MS = 15 * 60_000;

/** POSIX single-quote escaping for embedding argv in `sh -lc`. */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

export class SmolvmSandboxProvider implements SandboxProvider {
  readonly name = "smolvm";
  readonly displayName = "SmolVM (microVM)";
  readonly priority = 0; // explicit-only: never picked by auto
  readonly docsUrl = "https://docs.celesto.ai/smolvm/introduction";

  async detect(): Promise<SandboxDetection> {
    const platform = unsupportedPlatform();
    if (platform) return platform;

    const path = findInPath("smolvm");
    if (!path) {
      return {
        available: false,
        reason:
          'smolvm not found on PATH. Install: "curl -sSL https://celesto.ai/install.sh | bash" ' +
          "(or pip install smolvm && smolvm setup) — see docs.celesto.ai",
      };
    }

    // Name collision: smol-machines/smolvm (smolmachines.com) is an
    // unrelated Rust microVM runner with no agent subcommands — running
    // `smolvm claude start` against it fails. CelestoAI's CLI lists its
    // agent subcommands in --help; require one before reporting available.
    // (Full output, not first line: the subcommand list sits mid-help.)
    const help = probeCommandOutput(path, ["--help"]);
    if (help !== null && !/\bclaude\b|\bcodex\b/.test(help)) {
      return {
        available: false,
        reason:
          "found a different 'smolvm' binary (smol-machines microVM runner?) without agent " +
          "support. This provider needs CelestoAI SmolVM: " +
          '"curl -sSL https://celesto.ai/install.sh | bash" (see docs.celesto.ai)',
      };
    }

    if (process.platform === "linux") {
      const { accessSync, constants } = await import("fs");
      try {
        accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
      } catch {
        return {
          available: false,
          reason: "smolvm found, but /dev/kvm is not accessible (KVM required on Linux)",
        };
      }
      // This flow always mounts the working dir, and workspace mounts
      // require the QEMU backend (Firecracker has no virtio-9p).
      const qemuBinary = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
      if (!findInPath(qemuBinary)) {
        return {
          available: false,
          reason:
            `smolvm found, but ${qemuBinary} is missing — workspace mounts require the QEMU ` +
            "backend on Linux. Install your distro's QEMU system package (plus qemu-img)",
        };
      }
    }

    return { available: true, version: probeCommand(path, ["--version"]) ?? undefined };
  }

  supportsHarness(harnessName: string): boolean {
    return harnessName in SMOLVM_AGENT_NAMES;
  }

  wrapCommand(_path: string, args: readonly string[], policy: SandboxPolicy): WrappedCommand {
    const harnessName = policy.harnessName ?? "claude-code";
    const smolvmAgent = SMOLVM_AGENT_NAMES[harnessName];
    if (!smolvmAgent) {
      throw new Error(
        `SmolVM does not support the "${harnessName}" harness. ` +
          `Supported: ${Object.keys(SMOLVM_AGENT_NAMES).join(", ")}. ` +
          "Use AGENT_SANDBOX=nono or AGENT_SANDBOX=srt for other harnesses.",
      );
    }

    const sandboxName = `devintern-${process.pid}-${Date.now()}`;
    const workingDir = policy.workingDir;
    this.bootSandbox(smolvmAgent, sandboxName, workingDir);

    // `sandbox exec` has no --cwd, so wrap in sh -lc with quoted argv.
    // HOME is re-derived from passwd because the vsock exec channel (Linux)
    // injects HOME=/ — the agent then misses its forwarded credentials in
    // /root/.claude and starts logged out. Harmless where HOME is already
    // correct (ssh channel on macOS). IS_SANDBOX=1 tells claude-code it is
    // inside a sandbox: the guest user is root, and claude refuses
    // --dangerously-skip-permissions as root without it. Other agents
    // ignore the variable.
    const guestEnv = 'export HOME="$(getent passwd "$(id -u)" | cut -d: -f6)" IS_SANDBOX=1';
    const guestCommand = `${guestEnv} && cd ${shellQuote(workingDir)} && ${smolvmAgent} ${args.map(shellQuote).join(" ")}`;
    return {
      path: "smolvm",
      args: [
        "sandbox",
        "exec",
        sandboxName,
        "--timeout",
        String(EXEC_TIMEOUT_SECONDS),
        "--",
        "sh",
        "-lc",
        guestCommand,
      ],
      cleanup: async () => {
        // Best-effort: the sandbox may already be gone.
        probeCommand("smolvm", ["sandbox", "delete", sandboxName]);
      },
    };
  }

  /**
   * Boot the agent sandbox so `sandbox exec` has a running target.
   *
   * `smolvm <agent> start` boots the VM, installs the agent in the guest, and
   * forwards host agent credentials. Mounting the working dir at its own host
   * path keeps host-path arguments valid inside the guest. Overridable so
   * tests can assert the exec argv without booting a VM.
   */
  protected bootSandbox(smolvmAgent: string, sandboxName: string, workingDir: string): void {
    // Linux defaults to Firecracker, which does not support workspace mounts
    // (virtio-9p) — and smolvm 0.0.28 does not auto-select QEMU for --mount
    // despite its error hint saying it will. Force the QEMU backend, which
    // this flow always needs. macOS already defaults to QEMU.
    const backendArgs = process.platform === "linux" ? ["--backend", "qemu"] : [];
    const boot = spawnSync(
      "smolvm",
      [
        smolvmAgent,
        "start",
        "--name",
        sandboxName,
        "--mount",
        `${workingDir}:${workingDir}`,
        "--writable-mounts",
        "--no-attach",
        ...backendArgs,
      ],
      { encoding: "utf8", stdio: "pipe", timeout: BOOT_TIMEOUT_MS, env: process.env },
    );
    if (boot.error || boot.status !== 0) {
      const detail = boot.error?.message ?? boot.stderr?.trim() ?? `exit ${boot.status}`;
      throw new Error(`smolvm failed to boot sandbox "${sandboxName}": ${detail}`);
    }
  }
}
