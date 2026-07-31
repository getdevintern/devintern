/**
 * Shared agent-spawn entry point: compose sandbox wrapping with the
 * process-group reaper.
 *
 * Callers resolve the harness and build args as before, then call
 * {@link spawnAgent} instead of `spawnReapable` directly. Without a sandbox
 * the behavior is byte-identical to today's direct spawn; with one, the
 * invocation is rewritten by the provider first.
 */

import type { ChildProcess, SpawnOptions } from "child_process";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { spawnReapable } from "./process-reaper.js";
import type { ResolvedSandbox, SandboxPolicy } from "./sandbox/types.js";

export interface SpawnAgentOptions {
  /** Resolved agent executable path. */
  resolvedPath: string;
  /** Agent argv (flags + prompt), excluding the executable. */
  args: readonly string[];
  /** Standard spawn options (stdio, cwd, env) — passed through unchanged. */
  spawnOptions?: SpawnOptions;
  /** Result of `resolveSandbox()`; null/undefined spawns directly. */
  sandbox?: ResolvedSandbox | null;
  /** Policy overrides merged into the default policy (extra writable paths etc.). */
  policy?: Partial<SandboxPolicy>;
}

export interface SpawnedAgent {
  child: ChildProcess;
  /**
   * Tear down sandbox resources that outlive the child (microVMs). Callers
   * must await this after the child exits and on timeout/kill paths (after
   * `reapTree`). No-op when unsandboxed.
   */
  cleanup: () => Promise<void>;
}

/**
 * Build the default sandbox policy for an agent run.
 *
 * Write access covers the working directory, the task output dir, the OS
 * tmpdir (review worktrees, Chromium profile scratch, ssh-agent sockets),
 * and the Playwright/Puppeteer browser caches so agents that launch a
 * browser for testing or research keep working under filesystem confinement.
 * Network stays open: agents need LLM APIs, git push, and package registries.
 *
 * Env tuning: `AGENT_SANDBOX_WRITABLE_PATHS` (colon-separated) adds writable
 * paths; `AGENT_SANDBOX_ALLOWED_DOMAINS` (comma-separated) switches the
 * network policy to a domain allowlist (enforced by providers that support
 * network filtering, currently srt).
 *
 * @param workingDir - The directory the agent operates in.
 * @returns The default policy; callers may extend it via `SpawnAgentOptions.policy`.
 */
export function buildDefaultSandboxPolicy(workingDir: string): SandboxPolicy {
  const home = homedir();
  const browserCaches =
    process.platform === "darwin"
      ? [join(home, "Library", "Caches", "ms-playwright")]
      : [join(home, ".cache", "ms-playwright"), join(home, ".cache", "puppeteer")];

  const extraWritable = (process.env.AGENT_SANDBOX_WRITABLE_PATHS ?? "")
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean);
  const allowedDomains = (process.env.AGENT_SANDBOX_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  // On macOS the per-user temp AND cache trees live side by side under
  // /var/folders/<xx>/<hash>/ (T and C). tmpdir() alone (…/T) is too narrow:
  // agents also write the sibling cache dir — claude-code's auth check fails
  // as "not logged in" without it (verified under srt) — so grant the parent
  // user dir, which is still scoped to this user.
  const tempScope = process.platform === "darwin" ? dirname(tmpdir()) : tmpdir();

  return {
    writablePaths: [
      workingDir,
      process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks",
      tempScope,
      ...browserCaches,
      ...extraWritable,
    ],
    network: allowedDomains.length > 0 ? { allowedDomains } : "open",
    workingDir,
  };
}

/**
 * Spawn an agent process, optionally wrapped in a sandbox.
 *
 * @param options - Resolved invocation, spawn options, and optional sandbox.
 * @returns The reapable child and a cleanup hook for VM-backed providers.
 */
/** Providers that apply Seatbelt on macOS around the whole process. */
const SEATBELT_WRAPPERS = new Set(["nono", "srt"]);

/**
 * Avoid nested Seatbelt on macOS when an external wrapper contains a harness
 * that also self-sandboxes.
 *
 * Codex always runs with `--sandbox workspace-write` (its own Seatbelt on
 * macOS). `sandbox-exec` inside `sandbox-exec` is not supported, so under
 * nono/srt on macOS the inner sandbox would fail to initialize. The outer
 * wrapper already provides the (stronger, whole-process) boundary, so switch
 * codex's own sandbox off for the wrapped run. On Linux the layers stack
 * (Landlock/bwrap compose), so both are kept for defense in depth.
 *
 * Exported for tests; `platform` is injectable for the same reason.
 *
 * @param providerName - The active sandbox provider.
 * @param harnessName - The harness being wrapped.
 * @param args - The harness argv (pre-wrap).
 * @param platform - Defaults to `process.platform`.
 * @returns Possibly adjusted argv (a copy when adjusted).
 */
export function applyNestingGuard(
  providerName: string,
  harnessName: string | undefined,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform !== "darwin" || !SEATBELT_WRAPPERS.has(providerName)) {
    return args;
  }
  if (harnessName === "codex") {
    const index = args.indexOf("--sandbox");
    if (index !== -1 && args[index + 1] === "workspace-write") {
      const adjusted = [...args];
      adjusted[index + 1] = "danger-full-access";
      console.log(
        `🔒 Disabled codex's own sandbox inside ${providerName} (nested Seatbelt is ` +
          "unsupported on macOS; the outer sandbox is the enforcement boundary).",
      );
      return adjusted;
    }
  }
  return args;
}

export async function spawnAgent(options: SpawnAgentOptions): Promise<SpawnedAgent> {
  const { resolvedPath, args, spawnOptions = {}, sandbox } = options;

  if (!sandbox) {
    return {
      child: spawnReapable(resolvedPath, args, spawnOptions),
      cleanup: async () => {},
    };
  }

  const workingDir =
    options.policy?.workingDir ?? (spawnOptions.cwd as string | undefined) ?? process.cwd();
  const defaults = buildDefaultSandboxPolicy(workingDir);
  const policy: SandboxPolicy = {
    ...defaults,
    harnessName: sandbox.harnessName,
    ...options.policy,
    writablePaths: [...defaults.writablePaths, ...(options.policy?.writablePaths ?? [])],
  };

  const guardedArgs = applyNestingGuard(sandbox.provider.name, policy.harnessName, args);
  const wrapped = await sandbox.provider.wrapCommand(resolvedPath, guardedArgs, policy);
  const env = wrapped.env
    ? { ...(spawnOptions.env ?? process.env), ...wrapped.env }
    : spawnOptions.env;

  return {
    child: spawnReapable(wrapped.path, wrapped.args, { ...spawnOptions, env }),
    cleanup: wrapped.cleanup ?? (async () => {}),
  };
}
