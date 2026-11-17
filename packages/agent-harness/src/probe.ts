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
import type {
  AgentHarness,
  AgentRunOptions,
  HarnessInvocation,
  HarnessProbe,
  HarnessProbeOptions,
} from "./types.js";

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
 * Parse a full `major.minor.patch` version from a CLI version string.
 *
 * Accepts `X.Y.Z` and `X.Y` shapes (a missing patch is `0`) and ignores any
 * surrounding text (e.g. `"muse 1.4.11"`). Returns `undefined` when no
 * version is present.
 *
 * @param output - Raw `--version` output.
 * @returns The parsed components, or `undefined`.
 */
export function parseVersion(
  output: string,
): { major: number; minor: number; patch: number } | undefined {
  const match = output.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = match[3] ? Number.parseInt(match[3], 10) : 0;
  if ([major, minor, patch].some((n) => Number.isNaN(n))) {
    return undefined;
  }
  return { major, minor, patch };
}

/** Outcome of running `<executable> --version`. */
export interface CliVersionProbeResult {
  /** Version text when one could be read (possibly despite a non-zero exit). */
  output?: string;
  /** Concise reason the version could not be read; set only when `output` is absent. */
  failure?: string;
}

/**
 * A line that is only a version, optionally prefixed by one word (e.g.
 * `opencode v2.1.2`). The prefix is captured so callers can require it to be
 * the CLI's own program name rather than error text such as `Error 1.2`.
 */
const VERSION_LINE = /^(?:([\w.@/-]+)\s+)?v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/;
const MAX_FAILURE_REASON = 160;

/** Collapse whitespace and cap a probe failure reason to one short line. */
function summarizeFailure(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_FAILURE_REASON
    ? `${oneLine.slice(0, MAX_FAILURE_REASON - 1)}…`
    : oneLine;
}

/**
 * Find the first standalone version line in `text`.
 *
 * A prefixed line is accepted only when the prefix is `programName`
 * (case-insensitive); without a `programName` only bare versions match.
 */
function findVersionLine(text: string, programName?: string): string | undefined {
  const expected = programName?.toLowerCase();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => {
      const match = VERSION_LINE.exec(line);
      if (!match) {
        return false;
      }
      const prefix = match[1];
      return prefix === undefined || prefix.toLowerCase() === expected;
    });
}

/**
 * Run `<executable> --version` synchronously and describe the outcome.
 *
 * A zero exit returns the combined output. A non-zero exit still returns a
 * version when stdout/stderr contains a standalone version line (some CLIs
 * print the version and then fail on unrelated startup work, e.g. opening a
 * log file); that line must be a bare version or one prefixed by
 * `programName`, so error text like `Error 1.2` is not mistaken for a
 * version. Otherwise `failure` carries a trimmed reason for diagnostics.
 * Never throws.
 *
 * @param executablePath - Resolved path/command of the CLI.
 * @param options - Optional spawn environment.
 * @param programName - The CLI's own name as printed before its version
 *   (e.g. `opencode`); only consulted on a non-zero exit.
 * @returns The version output or a failure reason.
 */
export function probeCliVersion(
  executablePath: string,
  options: HarnessProbeOptions = {},
  programName?: string,
): CliVersionProbeResult {
  try {
    const result = spawnSync(executablePath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    if (result.error) {
      return { failure: summarizeFailure(result.error.message) };
    }
    const stdout = (result.stdout ?? "").trim();
    const stderr = (result.stderr ?? "").trim();
    if (result.status === 0) {
      // Keep the streams on separate lines: `1.2.3` + `4 plugins` must not
      // fuse into `1.2.34 plugins`.
      const output = [stdout, stderr].filter(Boolean).join("\n");
      return output ? { output } : { failure: "empty output" };
    }
    const version = findVersionLine(stdout, programName) ?? findVersionLine(stderr, programName);
    if (version) {
      return { output: version };
    }
    const exit =
      result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`;
    const detail = stderr || stdout;
    return { failure: detail ? `${exit}: ${summarizeFailure(detail)}` : exit };
  } catch (error) {
    return { failure: summarizeFailure(error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Run `<executable> --version` synchronously and return the raw output.
 *
 * Best-effort: returns `undefined` on a spawn failure, timeout, empty output,
 * or a non-zero exit without a recognizable version line, rather than
 * throwing. See {@link probeCliVersion} for the failure reason.
 *
 * @param executablePath - Resolved path/command of the CLI.
 * @param options - Optional spawn environment.
 * @param programName - See {@link probeCliVersion}.
 * @returns Version output trimmed, or `undefined`.
 */
export function readCliVersion(
  executablePath: string,
  options: HarnessProbeOptions = {},
  programName?: string,
): string | undefined {
  return probeCliVersion(executablePath, options, programName).output;
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
 * @param pathEnv - PATH to search for a bare command (defaults to `process.env.PATH`).
 * @returns True when the command exists and is executable.
 */
function executableExists(
  command: string,
  pathEnv: string | undefined = process.env.PATH,
): boolean {
  const isPath =
    isAbsolute(command) || command.includes(":") || command.includes("/") || command.includes("\\");
  const suffixes =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
      : [""];
  const candidates = isPath
    ? [isAbsolute(command) ? command : resolve(command)]
    : (pathEnv ?? "")
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
 * The cache only covers probes against the ambient `process.env`. A probe with
 * an explicit `env` (e.g. an isolated HOME) can see a different result, so it
 * bypasses the cache entirely.
 *
 * @param harness - Harness to probe.
 * @param executablePath - Resolved path/command of the CLI.
 * @param options - Optional environment for the probe process.
 * @returns The capability snapshot (possibly empty).
 */
export async function probeHarness(
  harness: AgentHarness,
  executablePath: string,
  options: HarnessProbeOptions = {},
): Promise<HarnessProbe> {
  if (!harness.probe) {
    return {};
  }
  const command = executablePath || harness.defaultPath;
  const run = (): Promise<HarnessProbe> =>
    Promise.resolve()
      .then(() => harness.probe!(command, options))
      .then((probe) => probe ?? {})
      .catch(() => ({}));
  if (options.env) {
    return run();
  }
  const key = `${harness.name}\0${command}`;
  let pending = probeCache.get(key);
  if (!pending) {
    pending = run();
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
 * @param probeOptions - Optional environment for the version probe; pass the
 *   environment the run will use when it differs from `process.env`.
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
  probeOptions: HarnessProbeOptions = {},
): Promise<HarnessInvocation> {
  if (harness.name === "deepseek" && isReasonixBinary(executablePath)) {
    throw new HarnessUnavailableError(
      `AGENT_HARNESS=deepseek resolves to the community Reasonix CLI (${executablePath}), ` +
        `but deepseek now selects DeepSeek's official experimental harness (dsh). ` +
        DEEPSEEK_REASONIX_MIGRATION_HINT,
      { harnessName: harness.name },
    );
  }
  const probe = await probeHarness(harness, executablePath, probeOptions);
  if (
    harness.name === "deepseek" &&
    !probe.version &&
    executableExists(executablePath || harness.defaultPath, probeOptions.env?.PATH)
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
