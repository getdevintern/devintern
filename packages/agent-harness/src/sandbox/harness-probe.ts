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
}

/**
 * Resolve the provider a configured `AGENT_SANDBOX` value would use.
 *
 * Returns `undefined` for `none`, unknown/unavailable providers, `auto` when
 * no provider is available, and when this process already runs inside an
 * enclosing sandbox that the chosen provider cannot nest in. Callers treat
 * that as "cannot preflight" and fail open rather than blocking startup on a
 * probe infrastructure problem.
 *
 * @param sandboxName - Configured sandbox name (`none`, `auto`, `nono`, …).
 * @param options - Optional environment override for enclosing-sandbox markers.
 */
export async function resolveProbeProvider(
  sandboxName: string,
  options: ProbeProviderOptions = {},
): Promise<SandboxProvider | undefined> {
  const name = sandboxName.trim();
  if (!name || name === "none") return undefined;

  const active = activeSandboxName(options.trustedEnv);
  // Mirror the resolver: `auto` never adds a second sandbox when one already
  // wraps this process, regardless of the picked provider's nesting support.
  if (name === "auto" && active) return undefined;

  let provider: SandboxProvider | undefined;
  if (name === "auto") {
    const detections = await detectSandboxProviders();
    provider = detections
      .filter(({ provider, detection }) => detection.available && provider.priority > 0)
      .sort((a, b) => b.provider.priority - a.provider.priority)[0]?.provider;
  } else {
    const candidate = getSandboxProvider(name);
    if (!candidate) return undefined;
    const detection = await candidate.detect();
    provider = detection.available ? candidate : undefined;
  }
  if (!provider) return undefined;

  // A kernel wrapper/native sandbox cannot nest inside the enclosing
  // confinement: probing through it would fail for reasons that do not apply
  // to the real run, which inherits the existing sandbox instead.
  if (active && !provider.canNestInSandbox) return undefined;
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
