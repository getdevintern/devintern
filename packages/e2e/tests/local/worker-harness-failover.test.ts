/**
 * Worker harness failover on a usage limit.
 *
 * Drives the real built `devintern worker` daemon with a two-entry
 * `AGENT_HARNESS` chain (`claude-code,codex`) whose harness CLIs are local
 * stubs under the fixture root. The primary stub prints a recognized
 * usage-limit line and exits non-zero; the fallback either delegates to the
 * deterministic fixture agent or also reports a limit. No real agent CLI,
 * account, model call, or network access is involved.
 */

import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

/**
 * Two lines so the detector matches `Claude usage limit reached` and reads the
 * adjacent `resets in 1 hour` hint (a single combined sentence is not a
 * recognized limit line).
 */
const LIMIT_LINES = ["Claude usage limit reached", "resets in 1 hour"];

interface FailoverStubs {
  primaryInvocations: string;
  fallbackInvocations: string;
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

/** Stub that only reports an exhausted usage window and exits non-zero. */
function createLimitStub(dir: string, name: string, invocations: string): string {
  const path = join(dir, name);
  writeStub(path, [
    "#!/bin/sh",
    recordInvocation(invocations),
    `printf '%s\\n' ${LIMIT_LINES.map((line) => `'${line}'`).join(" ")} >&2`,
    "exit 1",
  ]);
  return path;
}

/** Stub that hands the original argv to the deterministic fixture agent. */
function createDelegateStub(
  dir: string,
  name: string,
  invocations: string,
  agentPath: string,
): string {
  const path = join(dir, name);
  writeStub(path, [
    "#!/bin/sh",
    recordInvocation(invocations),
    `exec "${process.execPath}" "${agentPath}" "$@"`,
  ]);
  return path;
}

/**
 * Install the harness stubs and point the chain at them.
 *
 * The fixture's `prepare()` pins `AGENT_CLI_PATH` at the fake agent, and that
 * global override wins over every `<HARNESS>_CLI_PATH` during env-driven
 * resolution — including the failover entry. Clearing it is what makes the
 * retry spawn the codex stub instead of the primary again.
 */
function configureFailover(
  worker: WorkerFixture,
  fallbackBehavior: "delegate" | "limit" = "delegate",
): FailoverStubs {
  const dir = join(worker.root, "harness-stubs");
  mkdirSync(dir, { recursive: true });
  const primaryInvocations = join(dir, "claude-code-invocations.txt");
  const fallbackInvocations = join(dir, "codex-invocations.txt");
  const primary = createLimitStub(dir, "claude-code-limit.sh", primaryInvocations);
  const fallback =
    fallbackBehavior === "limit"
      ? createLimitStub(dir, "codex-limit.sh", fallbackInvocations)
      : createDelegateStub(
          dir,
          "codex-delegate.sh",
          fallbackInvocations,
          join(worker.root, "agent.ts"),
        );

  delete worker.env.AGENT_CLI_PATH;
  worker.env.AGENT_HARNESS = "claude-code,codex";
  worker.env.CLAUDE_CODE_CLI_PATH = primary;
  worker.env.CODEX_CLI_PATH = fallback;
  return { primaryInvocations, fallbackInvocations };
}

/** Number of times a stub was spawned. */
function invocationCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
}

/** Branch refs currently present on the local bare remote. */
async function remoteBranches(worker: WorkerFixture): Promise<string[]> {
  const output = await checkedCommand(
    ["git", "--git-dir", worker.remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    worker.root,
    worker.env,
  );
  return output.split("\n").filter(Boolean);
}

cliTest(
  "worker fails over from a usage-limited primary harness and completes on the fallback",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const stubs = configureFailover(worker);
      const task = await worker.addTask({
        title: "Expand the greeting across harnesses",
        body: "Change the greeting to Hello, world! and run bun test.",
      });

      // Enqueue before startup so the injection-only workspace stays valid.
      worker.start();
      await worker.waitForReady();
      const { task: settled, runs } = await worker.waitForSettled(task.id);

      const diagnostics = () =>
        [
          `injected task #${task.id} (${task.task_key}) settled as "${settled.status}": ${
            settled.message ?? "no message"
          }`,
          `runs: ${JSON.stringify(runs)}`,
          `primary invocations: ${invocationCount(stubs.primaryInvocations)}`,
          `fallback invocations: ${invocationCount(stubs.fallbackInvocations)}`,
          worker.tail(),
        ].join("\n");

      expect(settled.status, diagnostics()).toBe("done");
      const succeeded = runs.filter((run) => run.status === "succeeded");
      expect(succeeded, diagnostics()).toHaveLength(1);
      // The limited attempt is recorded as deferred (never failed), then the
      // retried attempt succeeds on the fallback.
      expect(
        runs.map((run) => run.status),
        diagnostics(),
      ).toEqual(["deferred", "succeeded"]);

      // Only the fallback reached the deterministic agent, and the primary was
      // spawned exactly once: no retry after its limit.
      expect(worker.agentInvocations(), diagnostics()).toEqual([{ mode: "implement" }]);
      expect(invocationCount(stubs.primaryInvocations), diagnostics()).toBe(1);
      expect(invocationCount(stubs.fallbackInvocations), diagnostics()).toBe(1);

      // The primary hit its limit after `prepare-branch` had already created
      // the unsuffixed feature ref (nothing was pushed), so the failover retry
      // is a fresh attempt and lands on the documented `-attempt-2` suffix.
      // Assert against the branch the successful run recorded, which is the
      // ref the daemon actually pushed.
      const expectedBranch = `feature/${task.task_key}`;
      const branch = succeeded[0]?.branch ?? "";
      expect(branch, diagnostics()).toBe(`${expectedBranch}-attempt-2`);
      expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      const changed = await checkedCommand(
        ["git", "--git-dir", worker.remote, "diff", "--name-only", worker.baseBranch, branch],
        worker.root,
        worker.env,
      );
      expect(changed.split("\n").filter(Boolean)).toEqual(["src/greeting.ts"]);

      // The worker names the failover instead of reporting a generic failure.
      expect(worker.logs).toContain("claude-code hit a usage limit");
      expect(worker.logs).toContain("failing over to codex");
      expect(worker.logs).not.toContain("task pipeline did not complete cleanly");
      expect(worker.logs).not.toContain("keeping worktree for debugging");

      // The queue persists the primary's future window and the fallback as the
      // active harness, so a restart does not retry the limited entry.
      const limits = await worker.waitFor("the primary's usage-limit window to be persisted", () =>
        (worker.rateLimits()["claude-code"] ?? 0) > Date.now() ? worker.rateLimits() : undefined,
      );
      expect(limits["claude-code"]).toBeGreaterThan(Date.now());
      expect(worker.activeHarness()).toBe("codex");
      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // Must exceed the helper's worst case: 20s readiness + 45s settle + 30s wait
  // + 25s SIGTERM + 5s SIGKILL, plus prepare() and daemon work.
  180_000,
);

cliTest(
  "worker defers the task and stays alive when every harness is usage-limited",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const stubs = configureFailover(worker, "limit");
      const task = await worker.addTask({
        title: "Every harness is limited",
        body: "Change the greeting to Hello, world! and run bun test.",
      });

      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(/All harnesses in the chain are usage-limited/);
      await worker.waitForOutput(/deferred; will retry next tick/);

      const limits = await worker.waitFor("both harnesses to be persisted as usage-limited", () => {
        const windows = worker.rateLimits();
        return (windows["claude-code"] ?? 0) > Date.now() && (windows.codex ?? 0) > Date.now()
          ? windows
          : undefined;
      });
      expect(limits["claude-code"]).toBeGreaterThan(Date.now());
      expect(limits.codex).toBeGreaterThan(Date.now());
      expect(worker.activeHarness()).toBe("codex");

      // The exhausted chain defers the row instead of settling it.
      const row = await worker.waitFor(`injected task #${task.id} to be requeued`, () => {
        const current = worker.injectedTask(task.id);
        return current?.status === "pending" ? current : undefined;
      });
      expect(row.status).toBe("pending");
      const runs = worker.runRecords(task.task_key);
      expect(runs.map((run) => run.status)).toEqual(["deferred", "deferred"]);
      expect(invocationCount(stubs.primaryInvocations)).toBe(1);
      expect(invocationCount(stubs.fallbackInvocations)).toBe(1);

      // No branch was pushed and the daemon survived the exhausted chain.
      expect(await remoteBranches(worker)).toEqual([worker.baseBranch]);
      expect(worker.running).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);
