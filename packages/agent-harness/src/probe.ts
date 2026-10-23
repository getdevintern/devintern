/**
 * Harness capability probing.
 *
 * Some harness CLIs change their flag surface between major versions (Opencode
 * v2 removed `--log-level`, `--dir`, and `--variant` and moved the working
 * directory to `$PWD`). Because users upgrade on their own schedule, we probe
 * the installed CLI once per executable and let a harness pick the right flags
 * for the version it finds, rather than assuming one version.
 *
 * Probing is best-effort: a missing or unparseable version resolves to `{}`,
 * and a harness must then fall back to its baseline (oldest supported)
 * behavior. `deepseek` is the exception: an unverifiable `dsh` is refused by
 * {@link buildHarnessInvocation} rather than spawned, because a same-named
 * unrelated program would receive the prompt.
 */

import { spawnSync } from "child_process";
import { accessSync, constants } from "fs";
import { delimiter, isAbsolute, join, resolve } from "path";
import { DEEPSEEK_REASONIX_MIGRATION_HINT, isReasonixBinary } from "./deepseek-migration.js";
import { warnEffortUnsupported } from "./effort.js";
import { HarnessUnavailableError } from "./errors.js";
import type { AgentHarness, AgentRunOptions, HarnessInvocation, HarnessProbe } from "./types.js";

/** Probe cache keyed by `harness name` + executable path, so each CLI runs once. */
const probeCache = new Map<string, Promise<HarnessProbe>>();

/**
 * Parse the major version from a CLI version string.
 *
 * Accepts the common `X.Y.Z` / `X.Y` shapes and ignores any surrounding text
 * (e.g. `"opencode 2.0.23"`), returning `undefined` when no version is present.
 *
 * @param output - Raw `--version` output.
 * @returns The major version number, or `undefined`.
 */
export function parseMajorVersion(output: string): number | undefined {
  const match = output.match(/(\d+)\.\d+(?:\.\d+)?/);
  if (!match?.[1]) {
    return undefined;
  }
  const major = Number.parseInt(match[1], 10);
  return Number.isNaN(major) ? undefined : major;
}

/**
 * Run `<executable> --version` synchronously and return the raw output.
 *
 * Best-effort: returns `undefined` on a spawn failure, non-zero exit, timeout,
 * or empty output rather than throwing.
 *
 * @param executablePath - Resolved path/command of the CLI.
 * @returns Combined stdout/stderr trimmed, or `undefined`.
 */
export function readCliVersion(executablePath: string): string | undefined {
  try {
    const result = spawnSync(executablePath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    if (result.error || result.status !== 0) {
      return undefined;
    }
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a command resolves to an executable file (path or PATH lookup).
 *
 * Kept local instead of importing `resolver.ts`: resolver imports the harness
 * registry, which imports the harnesses that import this module, so that would
 * form an import cycle. Used only to distinguish a missing CLI (whose existing
 * "CLI not found" error must win) from a different program answering `dsh`.
 *
 * @param command - Executable name or path.
 * @returns True when the command exists and is executable.
 */
function executableExists(command: string): boolean {
  const isPath =
    isAbsolute(command) || command.includes(":") || command.includes("/") || command.includes("\\");
  const suffixes =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
      : [""];
  const candidates = isPath
    ? [isAbsolute(command) ? command : resolve(command)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .flatMap((dir) => suffixes.map((suffix) => join(dir, `${command}${suffix}`)));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Probe a harness CLI once (cached per harness + executable path).
 *
 * Harnesses without a {@link AgentHarness.probe} implementation resolve to `{}`
 * without any I/O. Probe failures are swallowed so a run is never aborted by an
 * inability to determine the CLI version.
 *
 * @param harness - Harness to probe.
 * @param executablePath - Resolved path/command of the CLI.
 * @returns The capability snapshot (possibly empty).
 */
export async function probeHarness(
  harness: AgentHarness,
  executablePath: string,
): Promise<HarnessProbe> {
  if (!harness.probe) {
    return {};
  }
  const command = executablePath || harness.defaultPath;
  const key = `${harness.name}\0${command}`;
  let pending = probeCache.get(key);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => harness.probe!(command))
      .then((probe) => probe ?? {})
      .catch(() => ({}));
    probeCache.set(key, pending);
  }
  return pending;
}

/**
 * Build the complete invocation (args + env) for a harness run.
 *
 * Probes the CLI first so version-dependent harnesses can adapt, then delegates
 * to {@link AgentHarness.buildArgs} and {@link AgentHarness.buildEnv}.
 *
 * Every invocation path (the Bun/Node runners and the Code package's direct
 * spawns) goes through this function, so the effort capability warning is
 * emitted here rather than in each caller.
 *
 * @param harness - Harness being run.
 * @param executablePath - Resolved path/command of the CLI.
 * @param options - Per-run options.
 * @returns Args (prompt excluded) and any environment overlay.
 * @throws {HarnessUnavailableError} When `deepseek` resolves to the community
 *   Reasonix binary. `reasonix` accepts `run`, not `headless`, so spawning it
 *   as dsh only produces a usage error; fail with the migration guidance
 *   instead. The error type lets a worker fail over to the next harness entry
 *   rather than treating the task as a failed attempt.
 * @throws {HarnessUnavailableError} When `deepseek` resolves to a `dsh` that
 *   does not report a parseable version. Debian/Ubuntu's `dsh` package
 *   (Dancer's distributed shell) installs the same binary name but has no
 *   `--version`; spawning it would run the prompt as a remote shell command.
 */
export async function buildHarnessInvocation(
  harness: AgentHarness,
  executablePath: string,
  options: AgentRunOptions,
): Promise<HarnessInvocation> {
  if (harness.name === "deepseek" && isReasonixBinary(executablePath)) {
    throw new HarnessUnavailableError(
      `AGENT_HARNESS=deepseek resolves to the community Reasonix CLI (${executablePath}), ` +
        `but deepseek now selects DeepSeek's official experimental harness (dsh). ` +
        DEEPSEEK_REASONIX_MIGRATION_HINT,
      { harnessName: harness.name },
    );
  }
  const probe = await probeHarness(harness, executablePath);
  if (
    harness.name === "deepseek" &&
    !probe.version &&
    executableExists(executablePath || harness.defaultPath)
  ) {
    throw new HarnessUnavailableError(
      `AGENT_HARNESS=deepseek resolved ${executablePath || harness.defaultPath}, but it did not ` +
        `report a DeepSeek Harness version (dsh --version). Another program named "dsh" (for ` +
        `example Debian/Ubuntu's distributed shell) may be on PATH. Install the official CLI ` +
        `(npm i -g @deepseek-ai/dsh) or set DEEPSEEK_CLI_PATH to it.`,
      { harnessName: harness.name },
    );
  }
  warnEffortUnsupported(harness, options);
  return {
    args: harness.buildArgs(options, probe),
    env: harness.buildEnv?.(options, probe),
  };
}

/** Clear the probe cache. Exposed for tests that swap CLI versions. */
export function resetHarnessProbeCache(): void {
  probeCache.clear();
}
