/**
 * Shell stubs that stand in for agent harness CLIs in worker failover tests.
 *
 * A limit stub prints a recognized usage-limit pair and exits non-zero; a
 * delegate stub hands its argv to the deterministic fixture agent. Every stub
 * appends one line to its own invocation log per spawn, so a test can count
 * exactly which harness the worker launched. No real agent CLI, account, model
 * call, or network access is involved.
 */

import { expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerFixture, WorkerInjectedTask } from "./worker";

/** Reset hint used when a test does not need the window to elapse. */
export const ONE_HOUR_RESET = "resets in 1 hour";

/**
 * Two lines so the detector matches `Claude usage limit reached` and reads the
 * adjacent reset hint (a single combined sentence is not a recognized limit
 * line). The hint must start with a digit after `resets in`.
 */
function limitLines(resetHint: string): string[] {
  return ["Claude usage limit reached", resetHint];
}

/** Write an executable shell stub. */
function writeStub(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Append one line to a stub's invocation log on every spawn. */
function recordInvocation(path: string): string {
  return `printf '%s\\n' invoked >> "${path}"`;
}

/**
 * Shell lines that print the limit pair on stderr and exit non-zero.
 *
 * The pair goes out in one `write`: the CLI latches the first chunk that
 * matches a usage limit, so a reset hint arriving in a later chunk would be
 * dropped. A `printf` builtin writes stderr line by line, which splits the
 * pair under load; `cat` copies the whole heredoc in one write. The heredoc
 * body and terminator must stay unindented, even inside an `if`.
 */
function limitAndExit(resetHint: string): string[] {
  return ["cat >&2 <<'E2E_USAGE_LIMIT'", ...limitLines(resetHint), "E2E_USAGE_LIMIT", "exit 1"];
}

/** Shell line that hands the original argv to the fixture agent. */
function delegateTo(agentPath: string): string {
  return `exec "${process.execPath}" "${agentPath}" "$@"`;
}

/** Stub that only reports an exhausted usage window and exits non-zero. */
export function createLimitStub(
  dir: string,
  name: string,
  invocations: string,
  resetHint: string = ONE_HOUR_RESET,
): string {
  const path = join(dir, name);
  writeStub(path, ["#!/bin/sh", recordInvocation(invocations), ...limitAndExit(resetHint)]);
  return path;
}

/** Stub that hands the original argv to the deterministic fixture agent. */
export function createDelegateStub(
  dir: string,
  name: string,
  invocations: string,
  agentPath: string,
): string {
  const path = join(dir, name);
  writeStub(path, ["#!/bin/sh", recordInvocation(invocations), delegateTo(agentPath)]);
  return path;
}

/**
 * Stub that reports a usage limit on its first spawn only and delegates to the
 * fixture agent afterwards, standing in for a quota that came back once its
 * window elapsed. The invocation log doubles as the call counter.
 */
export function createLimitOnceStub(
  dir: string,
  name: string,
  invocations: string,
  agentPath: string,
  resetHint: string,
): string {
  const path = join(dir, name);
  writeStub(path, [
    "#!/bin/sh",
    recordInvocation(invocations),
    `if [ "$(wc -l < "${invocations}")" -le 1 ]; then`,
    ...limitAndExit(resetHint),
    "fi",
    delegateTo(agentPath),
  ]);
  return path;
}

/**
 * Stub that records its spawn, then blocks until the `gate` file exists before
 * handing the original argv to the fixture agent. A test holds a run in flight
 * on this harness for as long as it likes, then releases it by creating the
 * gate file. The wait polls the filesystem, so no signal or pipe is needed.
 */
export function createGatedDelegateStub(
  dir: string,
  name: string,
  invocations: string,
  agentPath: string,
  gate: string,
): string {
  const path = join(dir, name);
  writeStub(path, [
    "#!/bin/sh",
    recordInvocation(invocations),
    `while [ ! -e "${gate}" ]; do sleep 0.1; done`,
    delegateTo(agentPath),
  ]);
  return path;
}

export interface FailoverStubs {
  /** Directory holding every stub and invocation log. */
  dir: string;
  primaryInvocations: string;
  fallbackInvocations: string;
  /**
   * File that releases a `gated` fallback (create it to let the blocked run
   * continue). Present for every configuration; only `gated` waits on it.
   */
  fallbackGate: string;
}

export interface ConfigureFailoverOptions {
  /**
   * Fallback (`codex`) behavior: `delegate` to the fixture agent (default),
   * `limit` on every spawn, or `gated`, which delegates only after
   * {@link FailoverStubs.fallbackGate} exists.
   */
  fallback?: "delegate" | "gated" | "limit";
  /** Reset hint a `limit` fallback prints; defaults to {@link ONE_HOUR_RESET}. */
  fallbackResetHint?: string;
  /**
   * Primary (`claude-code`) behavior: `limit` on every spawn (default) or
   * `limit-once`, which delegates after the first spawn.
   */
  primary?: "limit" | "limit-once";
  /** Reset hint the primary prints; defaults to {@link ONE_HOUR_RESET}. */
  primaryResetHint?: string;
}

/**
 * Install the harness stubs and point a `claude-code,codex` chain at them.
 *
 * The fixture's `prepare()` pins `AGENT_CLI_PATH` at the fake agent, and that
 * global override wins over every `<HARNESS>_CLI_PATH` during env-driven
 * resolution — including the failover entry. Clearing it is what makes the
 * retry spawn the codex stub instead of the primary again.
 */
export function configureFailover(
  worker: WorkerFixture,
  options: ConfigureFailoverOptions = {},
): FailoverStubs {
  const dir = join(worker.root, "harness-stubs");
  mkdirSync(dir, { recursive: true });
  const agentPath = join(worker.root, "agent.ts");
  const primaryInvocations = join(dir, "claude-code-invocations.txt");
  const fallbackInvocations = join(dir, "codex-invocations.txt");
  const fallbackGate = join(dir, "codex-release");
  const resetHint = options.primaryResetHint ?? ONE_HOUR_RESET;
  const primary =
    options.primary === "limit-once"
      ? createLimitOnceStub(
          dir,
          "claude-code-limit-once.sh",
          primaryInvocations,
          agentPath,
          resetHint,
        )
      : createLimitStub(dir, "claude-code-limit.sh", primaryInvocations, resetHint);
  const fallback =
    options.fallback === "limit"
      ? createLimitStub(
          dir,
          "codex-limit.sh",
          fallbackInvocations,
          options.fallbackResetHint ?? ONE_HOUR_RESET,
        )
      : options.fallback === "gated"
        ? createGatedDelegateStub(
            dir,
            "codex-gated.sh",
            fallbackInvocations,
            agentPath,
            fallbackGate,
          )
        : createDelegateStub(dir, "codex-delegate.sh", fallbackInvocations, agentPath);

  delete worker.env.AGENT_CLI_PATH;
  worker.env.AGENT_HARNESS = "claude-code,codex";
  worker.env.CLAUDE_CODE_CLI_PATH = primary;
  worker.env.CODEX_CLI_PATH = fallback;
  return { dir, primaryInvocations, fallbackInvocations, fallbackGate };
}

/** Number of times a stub was spawned. */
export function invocationCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
}

/** Run one injected task to settlement and return its run statuses. */
export async function settleInjectedTask(
  worker: WorkerFixture,
  task: WorkerInjectedTask,
  diagnostics: () => string,
): Promise<string[]> {
  const { task: settled, runs } = await worker.waitForSettled(task.id);
  const detail = () =>
    [
      `injected task #${task.id} (${task.task_key}) settled as "${settled.status}": ${
        settled.message ?? "no message"
      }`,
      `runs: ${JSON.stringify(runs)}`,
      diagnostics(),
    ].join("\n");
  expect(settled.status, detail()).toBe("done");
  return runs.map((run) => run.status);
}

/** Stub invocation counts plus the daemon tail, for assertion messages. */
export function stubDiagnostics(
  worker: WorkerFixture,
  stubs: FailoverStubs,
  extra: () => string[] = () => [],
) {
  return () =>
    [
      `primary invocations: ${invocationCount(stubs.primaryInvocations)}`,
      `fallback invocations: ${invocationCount(stubs.fallbackInvocations)}`,
      ...extra(),
      `rate limits: ${JSON.stringify(worker.rateLimits())}`,
      `active harness: ${worker.activeHarness() ?? "unset"}`,
      worker.tail(),
    ].join("\n");
}
