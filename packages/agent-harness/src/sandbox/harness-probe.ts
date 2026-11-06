/**
 * Sandbox-aware harness readiness probe.
 *
 * `isHarnessCliAvailable()` only proves a path is executable. A mise shim can
 * pass that check and still fail before the agent starts: the shim runs
 * `mise use`, which needs to write its install directory, and nono/Landlock
 * denies that write. This probe executes `<path> --version` through the same
 * sandbox wrapper the real run uses, so a shim that cannot start is detected
 * at startup instead of burning a task attempt.
 *
 * The probe is deliberately cheap:
 * - no network dependency; `--version` only prints,
 * - a temporary working directory (never `$HOME`),
 * - a short timeout (10s default),
 * - results cached per `(path, sandbox provider, env fingerprint)`.
 */

import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildDefaultSandboxPolicy } from "../spawn-agent.js";
import { detectSandboxProviders } from "./detect.js";
import { sandboxInheritsEnclosingSandbox } from "./nesting.js";
import { getSandboxProvider } from "./registry.js";
import { activeSandboxName } from "./resolver.js";
import type { SandboxProvider } from "./types.js";

/** Result of probing a harness CLI through a sandbox provider. */
export type HarnessSandboxProbeResult = { ok: true } | { ok: false; reason: string };

/** Options for {@link probeHarnessUnderSandbox}. */
export interface HarnessSandboxProbeOptions {
  /** Resolved harness CLI path to execute. */
  path: string;
  /** Sandbox provider that will wrap the real run. */
  provider: SandboxProvider;
  /**
   * Directory the probe runs in. Defaults to a fresh temp directory so the
   * harness cannot write into the repository or the user's home.
   */
  workingDir?: string;
  /** Harness name, threaded into the sandbox policy (state-dir grants). */
  harnessName?: string;
  /** Probe timeout. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Environment to inspect/spawn with. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Set false to bypass the process-wide cache (tests). */
  useCache?: boolean;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

interface CacheEntry {
  provider: string;
  path: string;
  fingerprint: string;
  result: HarnessSandboxProbeResult;
}

const probeCache: CacheEntry[] = [];

/**
 * Environment variables that can change whether a harness starts under a
 * sandbox. The fingerprint invalidates cached probe results when any of them
 * changes (config reload, PATH change, per-harness CLI override).
 */
const FINGERPRINT_KEYS = new Set([
  "PATH",
  "HOME",
  "AGENT_SANDBOX",
  "AGENT_SANDBOX_NONO_PROFILE",
  "AGENT_SANDBOX_WRITABLE_PATHS",
  "AGENT_SANDBOX_ALLOWED_DOMAINS",
  "NONO_CAP_FILE",
  "SANDBOX_RUNTIME",
]);

function envFingerprint(env: NodeJS.ProcessEnv): string {
  const relevant = Object.entries(env)
    .filter(([key]) => FINGERPRINT_KEYS.has(key) || key.endsWith("_CLI_PATH"))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(relevant);
}

function cacheKey(provider: string, path: string, fingerprint: string): string {
  return `${provider}\u0000${path}\u0000${fingerprint}`;
}

/**
 * Drop cached probe results for the current process.
 *
 * Call after a configuration reload or when falling back to a harness: the
 * binary, its wrapper, or the sandbox policy may have changed.
 *
 * @param path - Only invalidate results for this harness path when provided.
 */
export function resetHarnessSandboxProbeCache(path?: string): void {
  if (!path) {
    probeCache.length = 0;
    return;
  }
  for (let index = probeCache.length - 1; index >= 0; index--) {
    if (probeCache[index]?.path === path) {
      probeCache.splice(index, 1);
    }
  }
}

/**
 * Pick the stderr line worth showing in a startup failure message.
 *
 * Prefers lines that identify an actionable startup problem (sandbox denial,
 * missing executable, mise install failure) over generic stack noise.
 *
 * @param stderr - Captured stderr.
 * @param stdout - Captured stdout, used only as a fallback.
 */
export function firstActionableProbeLine(stderr: string, stdout = ""): string | undefined {
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const actionable = lines.find((line) =>
    /mise\s+ERROR|Permission denied|EACCES|ENOENT|path_not_granted|sandbox|denied|not found|failed to/i.test(
      line,
    ),
  );
  return actionable ?? lines[0];
}

/** Options for {@link resolveProbeProvider}. */
export interface ProbeProviderOptions {
  /**
   * Environment to inspect for enclosing-sandbox markers. Defaults to the
   * trusted startup snapshot read by {@link activeSandboxName}, so tests can
   * inject markers without touching the real process environment.
   */
  trustedEnv?: NodeJS.ProcessEnv;
  /**
   * Primary harness the run is configured to launch. `resolveSandbox` rejects
   * an explicit provider that cannot wrap it before any nesting decision, so
   * the probe must exercise that provider (and report its failure) instead of
   * claiming the run inherits the enclosing sandbox.
   */
  harnessName?: string;
}

/**
 * Wrapper-free provider stand-in for a run that inherits an enclosing sandbox.
 *
 * Mirrors `resolveSandbox`: an explicitly requested provider that cannot nest
 * is skipped, and the harness executes inside the confinement already wrapping
 * this process. The probe therefore must not add a wrapper — it just runs
 * `<path> --version` so a CLI that cannot start under that confinement (the
 * mise-shim / permission-denied failure this module exists for) is still
 * detected instead of silently skipped.
 *
 * The name is deliberately distinct from the real provider's so wrapped and
 * inherited probe results never share a cache entry.
 *
 * Exported for callers that know a run inherits the enclosing sandbox but do
 * not go through {@link resolveProbeProvider} (e.g. the `devintern sandbox`
 * preflight, which resolves the provider from its own detections).
 *
 * @param activeSandbox - Provider name of the sandbox wrapping this process.
 * @param compatibility - Configured provider whose harness support still
 *   decides whether the run starts (inheriting does not make an unsupported
 *   harness runnable). Forwarded so callers can flag those entries as failures.
 */
export function inheritedSandboxProbeProvider(
  activeSandbox: string,
  compatibility?: Pick<SandboxProvider, "supportsHarness">,
): SandboxProvider {
  return {
    name: `${activeSandbox} (inherited)`,
    displayName: `inherited ${activeSandbox}`,
    priority: 0,
    detect: async () => ({ available: true }),
    ...(compatibility?.supportsHarness
      ? { supportsHarness: (harnessName: string) => compatibility.supportsHarness!(harnessName) }
      : {}),
    wrapCommand: (path, args) => ({ path, args: [...args] }),
  };
}

/**
 * Resolve the provider a configured `AGENT_SANDBOX` value would use.
 *
 * Returns `undefined` for `none`, unknown/unavailable providers, and `auto`
 * when no provider is available. When this process already runs inside an
 * enclosing sandbox the run inherits it (`auto` never adds a layer, and an
 * explicitly requested provider is skipped unless it can nest), so the probe
 * executes the harness directly through the wrapper-free stand-in instead of
 * being skipped: that exercises the confinement the real run will use.
 *
 * @param sandboxName - Configured sandbox name (`none`, `auto`, `nono`, …).
 * @param options - Optional environment override for enclosing-sandbox markers
 *   and the primary harness name to validate compatibility against.
 */
export async function resolveProbeProvider(
  sandboxName: string,
  options: ProbeProviderOptions = {},
): Promise<SandboxProvider | undefined> {
  const name = sandboxName.trim();
  if (!name || name === "none") return undefined;

  const harnessName = options.harnessName?.trim();
  const active = activeSandboxName(options.trustedEnv);
  // Mirror the resolver (`sandboxInheritsEnclosingSandbox`): `auto` never adds
  // a second sandbox when one already wraps this process, so the next run
  // spawns the harness unwrapped inside that confinement. Probe the same way
  // (same as the explicit non-nestable case below) instead of skipping: a
  // broken primary/fallback must still be detected.
  if (active && sandboxInheritsEnclosingSandbox({ configured: name, activeSandbox: active })) {
    return inheritedSandboxProbeProvider(active);
  }

  let provider: SandboxProvider | undefined;
  if (name === "auto") {
    const detections = await detectSandboxProviders();
    provider = detections
      .filter(
        ({ provider: candidate, detection }) =>
          detection.available &&
          candidate.priority > 0 &&
          (!harnessName || !candidate.supportsHarness || candidate.supportsHarness(harnessName)),
      )
      .sort((a, b) => b.provider.priority - a.provider.priority)[0]?.provider;
  } else {
    const candidate = getSandboxProvider(name);
    if (!candidate) return undefined;
    const detection = await candidate.detect();
    provider = detection.available ? candidate : undefined;
  }
  if (!provider) return undefined;

  // `resolveSandbox` rejects an explicit provider that cannot wrap the harness
  // before it decides about nesting, so the real run fails even inside an
  // enclosing sandbox. Probe through the provider so its `wrapCommand` reports
  // the incompatibility instead of pretending the run inherits the confinement.
  if (harnessName && provider.supportsHarness && !provider.supportsHarness(harnessName)) {
    return provider;
  }

  // A kernel wrapper/native sandbox cannot nest inside the enclosing
  // confinement: the real run inherits the existing sandbox instead of adding
  // this provider (`resolveSandbox` skips nesting). Probe the harness with no
  // wrapper so a CLI that cannot start under that confinement is still
  // detected at startup rather than silently kept.
  if (
    active &&
    sandboxInheritsEnclosingSandbox({ configured: name, activeSandbox: active, provider })
  ) {
    return inheritedSandboxProbeProvider(active, provider);
  }
  return provider;
}

/**
 * Execute `<path> --version` through a sandbox provider.
 *
 * @param options - Harness path, provider, working directory, and timeout.
 * @returns `{ ok: true }` when the harness version command exits 0, otherwise
 *   `{ ok: false, reason }` with the first actionable stderr line.
 */
export async function probeHarnessUnderSandbox(
  options: HarnessSandboxProbeOptions,
): Promise<HarnessSandboxProbeResult> {
  const env = options.env ?? process.env;
  const fingerprint = envFingerprint(env);
  const key = cacheKey(options.provider.name, options.path, fingerprint);

  if (options.useCache !== false) {
    const cached = probeCache.find(
      (entry) => cacheKey(entry.provider, entry.path, entry.fingerprint) === key,
    );
    if (cached) return cached.result;
  }

  const result = await runProbe(options, env);
  probeCache.push({
    provider: options.provider.name,
    path: options.path,
    fingerprint,
    result,
  });
  return result;
}

async function runProbe(
  options: HarnessSandboxProbeOptions,
  env: NodeJS.ProcessEnv,
): Promise<HarnessSandboxProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const ownsWorkingDir = options.workingDir === undefined;
  const workingDir = options.workingDir ?? mkdtempSync(join(tmpdir(), "devintern-harness-probe-"));

  try {
    const policy = {
      ...buildDefaultSandboxPolicy(workingDir),
      harnessName: options.harnessName,
    };
    const wrapped = await options.provider.wrapCommand(options.path, ["--version"], policy);
    const spawnEnv: NodeJS.ProcessEnv = { ...env };
    Object.assign(spawnEnv, wrapped.env);

    return await new Promise<HarnessSandboxProbeResult>((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: HarnessSandboxProbeResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (ownsWorkingDir) {
          try {
            rmSync(workingDir, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup: a leftover temp dir is harmless.
          }
        }
        // oxlint-disable-next-line promise/no-multiple-resolved -- `settled` guards a single resolution.
        resolve(result);
      };

      let child;
      try {
        child = spawn(wrapped.path, wrapped.args, {
          cwd: workingDir,
          env: spawnEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish({ ok: false, reason: message });
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may already have exited.
        }
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < 16_384) stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 16_384) stderr += chunk.toString();
      });

      child.on("error", (error: Error) => {
        finish({ ok: false, reason: error.message });
      });

      child.on("close", (code, signal) => {
        if (timedOut) {
          finish({ ok: false, reason: `timed out after ${timeoutMs}ms` });
          return;
        }
        if (code === 0) {
          finish({ ok: true });
          return;
        }
        const reason =
          firstActionableProbeLine(stderr, stdout) ??
          `exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
        finish({ ok: false, reason });
      });
    });
  } catch (error) {
    if (ownsWorkingDir) {
      try {
        rmSync(workingDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}
