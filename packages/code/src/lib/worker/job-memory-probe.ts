/**
 * `systemd-run` capability probes for job memory scopes.
 *
 * Kept apart from `job-memory.ts` so the probe machinery (and the
 * `--expand-environment` decision it needs) stays below the file-size limit.
 * The caller supplies the command to run inside the scope — the same OOM-shim
 * wrapper a real job gets — so a host without `/bin/sh` fails the probe.
 */

import { spawn, spawnSync } from "child_process";

/** Bound for one probe or version check. */
const SCOPE_PROBE_TIMEOUT_MS = 5_000;

/** systemd release that added `--expand-environment=` to `systemd-run`. */
const SYSTEMD_EXPAND_ENVIRONMENT_VERSION = 254;

/** Warn once when a failed probe cannot be attributed to an old release. */
let noExpandUnknownWarned = false;

/** Forget the one-time warning (tests that simulate different hosts). */
export function resetNoExpandProbeWarningForTests(): void {
  noExpandUnknownWarned = false;
}

function warnNoExpandUnknown(): void {
  if (noExpandUnknownWarned) return;
  noExpandUnknownWarned = true;
  console.warn(
    "⚠️  Job memory limit: could not determine whether systemd-run supports " +
      "--expand-environment=no; passing it so job arguments are never rewritten",
  );
}

/**
 * Run one scope probe synchronously.
 *
 * @param options - `systemd-run` options before `--`.
 * @param env - Environment (user bus and PATH).
 * @param command - Command a real job scope would run.
 * @returns True when the scope starts and the command exits zero.
 */
export function probeSystemdScope(
  options: readonly string[],
  env: Record<string, string | undefined>,
  command: readonly string[],
): boolean {
  const probe = spawnSync(
    "systemd-run",
    ["--user", "--scope", "--quiet", ...options, "--", ...command],
    { stdio: "ignore", timeout: SCOPE_PROBE_TIMEOUT_MS, env },
  );
  return probe.status === 0;
}

/**
 * Run one scope probe without blocking the event loop.
 *
 * @param options - `systemd-run` options before `--`.
 * @param env - Environment (user bus and PATH).
 * @param command - Command a real job scope would run.
 * @returns True when the scope starts and the command exits zero.
 */
export function probeSystemdScopeAsync(
  options: readonly string[],
  env: Record<string, string | undefined>,
  command: readonly string[],
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // oxlint-disable-next-line promise/no-multiple-resolved -- settled guards a single resolution.
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // The probe may already have exited.
      }
      finish(false);
    }, SCOPE_PROBE_TIMEOUT_MS);
    try {
      child = spawn("systemd-run", ["--user", "--scope", "--quiet", ...options, "--", ...command], {
        stdio: "ignore",
        env,
      });
    } catch {
      finish(false);
      return;
    }
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

function parseSystemdMajorVersion(output: string): number | undefined {
  const match = /^systemd (\d+)/m.exec(output);
  return match ? Number(match[1]) : undefined;
}

/** `systemd-run --version` major release, or undefined when it cannot be read. */
function systemdRunMajorVersion(env: Record<string, string | undefined>): number | undefined {
  try {
    const probe = spawnSync("systemd-run", ["--version"], {
      encoding: "utf8",
      timeout: SCOPE_PROBE_TIMEOUT_MS,
      env,
    });
    if (probe.status !== 0 || typeof probe.stdout !== "string") return undefined;
    return parseSystemdMajorVersion(probe.stdout);
  } catch {
    return undefined;
  }
}

/** Async {@link systemdRunMajorVersion} so startup probing never blocks the loop. */
function systemdRunMajorVersionAsync(
  env: Record<string, string | undefined>,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    let stdout = "";
    const finish = (major: number | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // oxlint-disable-next-line promise/no-multiple-resolved -- settled guards a single resolution.
      resolve(major);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // The version probe may already have exited.
      }
      finish(undefined);
    }, SCOPE_PROBE_TIMEOUT_MS);
    try {
      child = spawn("systemd-run", ["--version"], { env });
    } catch {
      finish(undefined);
      return;
    }
    child.stdout?.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => finish(code === 0 ? parseSystemdMajorVersion(stdout) : undefined));
  });
}

/**
 * Decide `--expand-environment=no` support without mistaking a failed probe
 * for a missing flag.
 *
 * The option exists from systemd 254 and is what keeps systemd 258+ from
 * expanding `${VAR}` in the job command line. A scope probe that fails can be
 * a genuinely unsupported flag (older releases never expand, so omitting it is
 * correct) or a timeout/transient manager failure (omitting it on 258+
 * rewrites job arguments). A retry absorbs the transient case; when it also
 * fails, the binary's version decides. An unknown version keeps the flag on:
 * a host that rejects it reruns the job unwrapped, which is safe, while a
 * missing flag can corrupt the command line.
 *
 * @param options - The `--expand-environment=no` scope argv.
 * @param env - Environment (user bus and PATH).
 * @param command - Command a real job scope would run.
 */
export function probeNoExpand(
  options: readonly string[],
  env: Record<string, string | undefined>,
  command: readonly string[],
): boolean {
  if (probeSystemdScope(options, env, command)) return true;
  if (probeSystemdScope(options, env, command)) return true;
  const major = systemdRunMajorVersion(env);
  if (major !== undefined) return major >= SYSTEMD_EXPAND_ENVIRONMENT_VERSION;
  warnNoExpandUnknown();
  return true;
}

/** Async {@link probeNoExpand}. */
export async function probeNoExpandAsync(
  options: readonly string[],
  env: Record<string, string | undefined>,
  command: readonly string[],
): Promise<boolean> {
  if (await probeSystemdScopeAsync(options, env, command)) return true;
  if (await probeSystemdScopeAsync(options, env, command)) return true;
  const major = await systemdRunMajorVersionAsync(env);
  if (major !== undefined) return major >= SYSTEMD_EXPAND_ENVIRONMENT_VERSION;
  warnNoExpandUnknown();
  return true;
}
