/**
 * Anthropic Sandbox Runtime (srt) provider.
 *
 * srt (github.com/anthropic-experimental/sandbox-runtime, npm
 * @anthropic-ai/sandbox-runtime) wraps arbitrary processes using sandbox-exec
 * on macOS and bubblewrap + seccomp on Linux, with proxy-based network
 * filtering. Signals forward through srt to the wrapped process, so the
 * reaper in `process-reaper.ts` works unchanged.
 *
 * CLI: srt --settings <file> <command> [args...]
 *
 * A per-run settings file is generated from the policy. v1 enforces write
 * confinement only: reads stay open so ssh keys, gitconfig, and credential
 * helpers keep working, and network defaults to open (LLM APIs, git push,
 * package registries). Domain allowlists map to `network.allowedDomains`;
 * note srt's network filter is proxy-env based (HTTP_PROXY/HTTPS_PROXY/
 * ALL_PROXY), so programs that ignore proxy vars lose connectivity when an
 * allowlist is set.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findInPath } from "../../resolver.js";
import {
  ensureHarnessStateDir,
  harnessStateAbsolutePaths,
  resolveHomeDir,
} from "../harness-state.js";
import { probeCommand, unsupportedPlatform } from "../probe.js";
import type { SandboxDetection, SandboxPolicy, SandboxProvider, WrappedCommand } from "../types.js";

/** Linux binaries srt requires beyond the srt CLI itself. */
const LINUX_DEPS = ["bwrap", "socat", "rg"];

/**
 * Default allowlist standing in for the policy's "open" network — srt's
 * schema refuses "*" and broad wildcards, so open maps to agent essentials:
 * model APIs (Anthropic / OpenAI / Google), agent telemetry, git hosts, and
 * the common package registries. Extend per run with
 * AGENT_SANDBOX_ALLOWED_DOMAINS (which replaces this list).
 */
const SRT_OPEN_NETWORK_DOMAINS = [
  // Model APIs + agent auth/telemetry
  "api.anthropic.com",
  "*.anthropic.com",
  "claude.ai",
  "*.claude.ai",
  "claude.com",
  "*.claude.com",
  "api.openai.com",
  "*.openai.com",
  "generativelanguage.googleapis.com",
  "*.googleapis.com",
  "statsig.com",
  "*.statsig.com",
  "sentry.io",
  "*.sentry.io",
  // Git hosts
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "gitlab.com",
  "*.gitlab.com",
  "bitbucket.org",
  "*.bitbucket.org",
  // Package registries
  "registry.npmjs.org",
  "*.npmjs.org",
  "*.yarnpkg.com",
  "bun.sh",
  "*.bun.sh",
  "pypi.org",
  "*.pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "*.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "repo.maven.apache.org",
];

/**
 * Top-level lock files some harnesses create next to their state. They are
 * granted even when they do not exist yet — the agent creates them on its
 * first run.
 */
const HARNESS_STATE_LOCK_FILES: Record<string, string[]> = {
  "claude-code": [".claude.json.lock", ".claude.lock"],
};

/**
 * Absolute $HOME paths the harness itself must be able to write (session
 * files, settings, locks) — an agent denied these starts logged-out or exits.
 * Shares the audited per-harness state map with the nono provider.
 */
function harnessStateWritePaths(
  harnessName: string | undefined,
  stateEnv?: NodeJS.ProcessEnv,
): string[] {
  const home = resolveHomeDir();
  const name = harnessName ?? "claude-code";
  // A trusted custom DSH_HOME may not exist yet (fresh first run); create it
  // so the grant below is not filtered out for a missing path.
  ensureHarnessStateDir(name, stateEnv);
  const state = harnessStateAbsolutePaths(name, home, stateEnv);
  const locks = (HARNESS_STATE_LOCK_FILES[name] ?? []).map((path) => join(home, path));
  return [...state, ...locks].filter((path) => existsSync(path) || path.endsWith(".lock"));
}

export class SrtSandboxProvider implements SandboxProvider {
  readonly name = "srt";
  readonly displayName = "Anthropic Sandbox Runtime (srt)";
  readonly priority = 20;
  readonly docsUrl = "https://github.com/anthropic-experimental/sandbox-runtime";

  /**
   * @param stateEnv - Trusted startup environment that gates the custom
   *   `DSH_HOME` root opt-in. Defaults to the snapshot captured before the
   *   host merges the repository `.env`; tests pass `process.env`. `DSH_HOME`
   *   itself is read from the environment the harness child receives.
   */
  constructor(private readonly stateEnv?: NodeJS.ProcessEnv) {}

  async detect(): Promise<SandboxDetection> {
    const platform = unsupportedPlatform();
    if (platform) return platform;

    const path = findInPath("srt");
    if (!path) {
      return {
        available: false,
        reason:
          'srt not found on PATH. Install: "npm install -g @anthropic-ai/sandbox-runtime" ' +
          "(or bun add -g)",
      };
    }

    if (process.platform === "linux") {
      const missing = LINUX_DEPS.filter((dep) => !findInPath(dep));
      if (missing.length > 0) {
        return {
          available: false,
          reason: `srt found, but required Linux dependencies are missing: ${missing.join(", ")} (install bubblewrap, socat, ripgrep)`,
        };
      }
    }

    return { available: true, version: probeCommand(path, ["--version"]) ?? undefined };
  }

  wrapCommand(path: string, args: readonly string[], policy: SandboxPolicy): WrappedCommand {
    // Local binding (dev servers, Playwright CDP) and the ssh-agent socket
    // (git push over ssh) must be granted explicitly — srt denies both by
    // default, same runtime and schema as Claude Code's built-in sandbox.
    const sshAgentSocket = process.env.SSH_AUTH_SOCK;
    // srt (validated against 1.3.0) requires an explicit allowlist: a bare
    // "*" and broad patterns are rejected by the schema, and the network /
    // deny fields are mandatory. The policy's "open" network therefore maps
    // to a default allowlist of agent essentials (model APIs, git hosts,
    // package registries) — override with AGENT_SANDBOX_ALLOWED_DOMAINS.
    // strictAllowlist keeps unlisted hosts deterministically denied (403)
    // instead of consulting an interactive ask callback.
    const settings = {
      network: {
        allowedDomains:
          policy.network === "open" ? SRT_OPEN_NETWORK_DOMAINS : policy.network.allowedDomains,
        deniedDomains: [],
        strictAllowlist: true,
        allowLocalBinding: true,
        ...(sshAgentSocket ? { allowUnixSockets: [sshAgentSocket] } : {}),
      },
      filesystem: {
        allowWrite: [
          ...policy.writablePaths,
          ...harnessStateWritePaths(policy.harnessName, this.stateEnv),
        ],
        denyRead: [],
        denyWrite: [],
        ...(policy.readablePaths?.length ? { allowRead: policy.readablePaths } : {}),
      },
    };

    const settingsDir = mkdtempSync(join(tmpdir(), "devintern-srt-"));
    const settingsFile = join(settingsDir, "srt-settings.json");
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

    // srt remaps TMPDIR inside the sandbox to /tmp/claude but does not create
    // it. Tools that mkdtemp under TMPDIR without creating parents (Playwright
    // browser launches) fail with ENOENT until it exists, so pre-create it.
    try {
      mkdirSync("/tmp/claude", { recursive: true });
    } catch {
      // Non-fatal: the sandboxed process can create it itself if needed.
    }

    return { path: "srt", args: ["--settings", settingsFile, path, ...args] };
  }
}
