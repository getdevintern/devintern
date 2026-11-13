/**
 * Probe real installed agent harness CLIs with DevIntern's generated invocation.
 *
 * The rest of the E2E suite drives the built CLI with a deterministic fake
 * agent. These checks close the gap between unit-tested argument builders and
 * the flag surface a real installed CLI accepts: a removed subcommand, renamed
 * flag, or changed prompt mode fails immediately with a parser/usage error.
 *
 * The probe deliberately requires no account or model access. It runs with an
 * isolated home (so ambient credentials are not inherited), ignores
 * authentication prompts, and treats a timeout as acceptable startup latency.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHarnessInvocation,
  buildPromptArgs,
  getHarnessCliCommand,
  isHarnessInstalled,
  listHarnesses,
  reapTree,
  resolveExecutablePath,
  spawnReapable,
} from "@devintern/agent-harness";
import type { AgentHarness } from "@devintern/agent-harness";
import { isolatedEnvironment } from "./environment";

/** Harmless prompt: enough to enter non-interactive mode, never a real task. */
export const HARNESS_PROBE_PROMPT =
  "Reply with the single word OK. Do not use tools, read files, or make network requests.";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CAPTURED_OUTPUT = 64_000;

/** A registered harness plus whether its CLI is reachable on this machine. */
export interface DiscoveredHarness {
  harness: AgentHarness;
  installed: boolean;
  /** Resolved executable path; empty when the harness is not installed. */
  path: string;
}

/** Result of launching a harness with the invocation DevIntern would generate. */
export interface HarnessInvocationProbe {
  /** Full argv, including the prompt, that was passed to the CLI. */
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const PARSER_ERRORS: ReadonlyArray<readonly [string, RegExp]> = [
  ["unknown option", /\bunknown option\b/i],
  ["unknown argument", /\bunknown argument\b/i],
  ["unexpected argument", /\bunexpected argument\b/i],
  ["invalid option", /\binvalid option\b/i],
  ["unrecognized argument", /\bunrecognized arguments?\b/i],
  ["unrecognized option", /\bunrecognized option\b/i],
  ["invalid option value", /\berror: option .+ is invalid\b/i],
  ["undefined flag", /\bflag provided but not defined\b/i],
  ["unknown subcommand", /\b(?:unknown|invalid) subcommand\b/i],
];

/** Usage/help headings CLI parsers print when they reject an argv. */
const HELP_HEADING = /^\s*(?:DESCRIPTION|USAGE|Usage:)/im;
const HELP_SECTION = /\b(?:FLAGS|OPTIONS|Options:|Commands:)\b/;

/**
 * Discover every registered harness and resolve the executable when installed.
 *
 * Uses the same env-aware lookup as the CLI (`AGENT_CLI_PATH`,
 * `<HARNESS>_CLI_PATH`, then the harness default), so overrides configured by a
 * developer are exercised here too.
 */
export function discoverHarnesses(): DiscoveredHarness[] {
  return listHarnesses().map((harness) => {
    const installed = isHarnessInstalled(harness);
    return {
      harness,
      installed,
      path: installed ? resolveExecutablePath(getHarnessCliCommand(harness)) : "",
    };
  });
}

/** Read the per-harness probe timeout, falling back to ten seconds. */
function probeTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.E2E_HARNESS_PROBE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Launch one installed harness with the argv DevIntern would build for a run.
 *
 * The child gets a fresh temporary home and workspace so it cannot read the
 * developer's harness credentials or mutate a real repository. Its process
 * group is killed on timeout so harness-spawned children do not leak.
 *
 * @param entry - Harness discovery entry with a resolved executable path.
 * @param options - Optional timeout override in milliseconds.
 * @returns Captured invocation, exit information, and bounded output.
 */
export async function probeHarnessInvocation(
  entry: DiscoveredHarness,
  options: { timeoutMs?: number } = {},
): Promise<HarnessInvocationProbe> {
  if (!entry.installed || !entry.path) {
    throw new Error(`${entry.harness.displayName} is not installed; refusing to probe it`);
  }

  const root = mkdtempSync(join(tmpdir(), "devintern-harness-probe-"));
  try {
    const workingDir = join(root, "repo");
    mkdirSync(workingDir, { recursive: true });
    const environment = isolatedEnvironment(root);
    const invocation = await buildHarnessInvocation(entry.harness, entry.path, {
      // Match the CLI's implementation run: non-interactive, permissions
      // skipped, and a bounded turn count where the harness supports it.
      skipPermissions: true,
      maxTurns: 2,
      workingDir,
    });
    const args = [...invocation.args, ...buildPromptArgs(entry.harness, HARNESS_PROBE_PROMPT)];
    const child = spawnReapable(entry.path, args, {
      cwd: workingDir,
      env: { ...environment, ...invocation.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const capture = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_CAPTURED_OUTPUT) return current;
      return current + chunk.toString().slice(0, MAX_CAPTURED_OUTPUT - current.length);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = capture(stderr, chunk);
    });

    const startedAt = Date.now();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    timer = setTimeout(() => {
      timedOut = true;
      reapTree(child, "SIGKILL");
    }, options.timeoutMs ?? probeTimeoutMs());

    let exitCode: number | null;
    try {
      exitCode = await closed;
    } finally {
      clearTimeout(timer);
    }

    return {
      args,
      exitCode,
      timedOut,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Classify a probe as a rejected invocation or an acceptable non-result.
 *
 * A rejected invocation must have failed (non-zero exit) and printed a parser
 * or usage error. Authentication failures, missing provider keys, model errors,
 * and timeouts are all acceptable: they prove the CLI parsed the invocation and
 * reached its own startup path. Restricting the check to failed runs also keeps
 * model output that merely mentions "unknown option" from causing a false
 * positive.
 *
 * @param result - Captured probe result.
 * @returns A human-readable rejection reason, or `undefined` when acceptable.
 */
export function detectInvocationRejection(
  result: Pick<HarnessInvocationProbe, "exitCode" | "timedOut" | "stdout" | "stderr">,
): string | undefined {
  if (result.timedOut || result.exitCode === 0) return undefined;
  const output = `${result.stdout}\n${result.stderr}`;
  for (const [reason, pattern] of PARSER_ERRORS) {
    if (pattern.test(output)) return `CLI rejected the generated arguments (${reason})`;
  }
  if (HELP_HEADING.test(output) && HELP_SECTION.test(output)) {
    return "CLI printed usage/help instead of accepting the generated arguments";
  }
  return undefined;
}
