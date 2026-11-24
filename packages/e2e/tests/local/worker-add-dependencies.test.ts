/**
 * Ad-hoc task dependencies: `worker add --after` and `Depends on:` lines.
 *
 * The local bare remote has no code-host platform, so the default dependency
 * mode resolves to `merged`, and the workspace omits `--create-pr`: a
 * dependency that succeeds without a PR is satisfied (`via: "no-pr"`). State is
 * read through `worker queue --json` and `worker runs … --json` only.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { CleanupFailure } from "../../helpers/cleanup";
import { throwCleanupFailures } from "../../helpers/cleanup";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerFixtureOptions } from "../../helpers/worker";
import {
  cliQueue,
  cliRun,
  cliRuns,
  pollCli,
  singleJson,
  waitForSettledRun,
} from "../../helpers/worker-cli-state";
import type { CliQueuedItem } from "../../helpers/worker-cli-state";

const cliTest = test.skipIf(!existsSync(cliPath));

/** No `--create-pr`: a local bare remote cannot host a PR, so none is attempted. */
const NO_PR_TASK_ARGS = "--skip-clarity-check --skip-comments";

interface AddJson {
  id: number;
  taskKey: string;
  repo: string;
  status: string;
  dependsOn?: string[];
  dependencyMode?: string;
  dependencyState?: string;
  dependencyReason?: string;
}

function fixture(options: WorkerFixtureOptions = {}): WorkerFixture {
  return new WorkerFixture({ workerTaskArgs: NO_PR_TASK_ARGS, ...options });
}

async function add(worker: WorkerFixture, args: string[]): Promise<AddJson> {
  const result = await worker.runAdd([...args, "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  return singleJson<AddJson>(result);
}

async function queuedItem(
  worker: WorkerFixture,
  taskKey: string,
): Promise<CliQueuedItem | undefined> {
  return (await cliQueue(worker)).items.find((item) => item.taskKey === taskKey);
}

/** Run cleanup steps in order, attempting every one even after a failure. */
async function cleanup(steps: Array<[string, () => Promise<void> | void]>): Promise<void> {
  const failures: CleanupFailure[] = [];
  for (const [resource, step] of steps) {
    try {
      await step();
    } catch (error) {
      failures.push({ resource, error });
    }
  }
  throwCleanupFailures("worker dependency test cleanup failed", failures);
}

cliTest(
  "worker add --after and Depends on: hold dependents until the dependency succeeds",
  async () => {
    const worker = fixture();
    try {
      await worker.prepare();
      // Slow enough that A is observably running while B and C wait.
      worker.env.E2E_AGENT_DELAY_MS = "4000";
      const a = await add(worker, [
        "--title",
        "Chain root",
        "--body",
        "Change the greeting to Hello, world!",
      ]);
      expect(a.dependsOn).toBeUndefined();

      const b = await add(worker, [
        "--title",
        "Chain after flag",
        "--body",
        "Make the greeting friendlier.",
        "--after",
        a.taskKey,
      ]);
      expect(b.dependsOn).toEqual([a.taskKey]);
      expect(b.dependencyMode).toBe("merged");

      const c = await add(worker, [
        "--title",
        "Chain after body line",
        "--body",
        `Make the greeting friendlier.\n\n**Depends on**: ${a.taskKey}`,
      ]);
      expect(c.dependsOn).toEqual([a.taskKey]);
      expect(c.dependencyMode).toBe("merged");

      worker.start();
      await worker.waitForReady();

      await pollCli(worker, `${a.taskKey} to start`, async () => {
        const runs = await cliRuns(worker, a.taskKey);
        return runs.some((run) => run.status === "in_progress") ? true : undefined;
      });
      const waiting = await pollCli(worker, `${b.taskKey} waiting on a running A`, async () => {
        const item = await queuedItem(worker, b.taskKey);
        return item?.dependencyState === "waiting" && item.dependencyReason?.includes("running")
          ? item
          : undefined;
      });
      expect(waiting.dependsOn).toEqual([a.taskKey]);
      expect(waiting.dependencyMode).toBe("merged");
      expect(waiting.dependencyReason).toContain(a.taskKey);
      const cWaiting = await queuedItem(worker, c.taskKey);
      expect(cWaiting?.dependencyState).toBe("waiting");
      expect(cWaiting?.dependencyReason).toContain(a.taskKey);
      // Neither dependent has a run while A is still in progress.
      expect(await cliRuns(worker, b.taskKey)).toHaveLength(0);
      expect(await cliRuns(worker, c.taskKey)).toHaveLength(0);

      const [aRun] = await waitForSettledRun(worker, a.taskKey);
      expect(aRun!.status).toBe("succeeded");
      const aDetail = await cliRun(worker, aRun!.id);
      expect(aDetail.finishedAt).toBeDefined();

      const [bRun] = await waitForSettledRun(worker, b.taskKey);
      const [cRun] = await waitForSettledRun(worker, c.taskKey);
      expect(bRun!.status).toBe("succeeded");
      expect(cRun!.status).toBe("succeeded");
      expect(bRun!.startedAt).toBeGreaterThanOrEqual(aDetail.finishedAt!);
      expect(cRun!.startedAt).toBeGreaterThanOrEqual(aDetail.finishedAt!);
      expect((await cliQueue(worker)).items).toHaveLength(0);
    } finally {
      await cleanup([["worker fixture", () => worker.dispose()]]);
    }
  },
  240_000,
);

cliTest(
  "worker add dependency validation rejects unknown and cross-repo keys and ignores stray Depends on:",
  async () => {
    const worker = fixture({ repos: ["fixture", "other"] });
    try {
      await worker.prepare();
      const local = await add(worker, ["--repo", "fixture", "--title", "Local root"]);
      const foreign = await add(worker, ["--repo", "other", "--title", "Other repo root"]);
      const before = (await cliQueue(worker)).items.map((item) => item.taskKey).sort();
      expect(before).toEqual([local.taskKey, foreign.taskKey].sort());

      const unknown = await worker.runAdd([
        "--repo",
        "fixture",
        "--title",
        "After an unknown key",
        "--after",
        "local-does-not-exist",
        "--json",
      ]);
      expect(unknown.exitCode).not.toBe(0);
      expect(unknown.stderr).toContain("unknown dependency local-does-not-exist");
      expect(unknown.stdout.trim()).toBe("");

      const crossRepo = await worker.runAdd([
        "--repo",
        "fixture",
        "--title",
        "After another repo's task",
        "--after",
        foreign.taskKey,
        "--json",
      ]);
      expect(crossRepo.exitCode).not.toBe(0);
      expect(crossRepo.stderr).toContain("cross-repo dependencies are not supported");
      expect(crossRepo.stderr).toContain(foreign.taskKey);
      expect(crossRepo.stdout.trim()).toBe("");

      const after = (await cliQueue(worker)).items.map((item) => item.taskKey).sort();
      expect(after).toEqual(before);

      const stray = await worker.runAdd([
        "--repo",
        "fixture",
        "--title",
        "Mentions a tracker ticket",
        "--body",
        "Context only.\n\nDepends on: PROJ-12",
        "--json",
      ]);
      expect(stray.exitCode, stray.stderr).toBe(0);
      expect(stray.stderr).toContain("Ignoring 'Depends on:' PROJ-12");
      const strayJson = singleJson<AddJson>(stray);
      expect(strayJson.status).toBe("pending");
      expect(strayJson.dependsOn).toBeUndefined();
      const strayItem = await queuedItem(worker, strayJson.taskKey);
      expect(strayItem).toBeDefined();
      expect(strayItem!.dependsOn).toBeUndefined();
      expect(strayItem!.dependencyState).toBeUndefined();
    } finally {
      await cleanup([["worker fixture", () => worker.dispose()]]);
    }
  },
  120_000,
);

cliTest(
  "worker add --after: a failed dependency blocks its dependent until --resume succeeds",
  async () => {
    const worker = fixture();
    const marker = "E2EFAILCHAINROOT";
    try {
      await worker.prepare();
      worker.env.E2E_FAIL_PROMPT_MARKER = marker;
      const a = await add(worker, [
        "--title",
        "Failing root",
        "--body",
        `Change the greeting to Hello, world! ${marker}`,
      ]);
      const b = await add(worker, [
        "--title",
        "After the failing root",
        "--body",
        "Make the greeting friendlier.",
        "--after",
        a.taskKey,
      ]);
      expect(b.dependsOn).toEqual([a.taskKey]);

      worker.start();
      await worker.waitForReady();
      const [aFailed] = await waitForSettledRun(worker, a.taskKey);
      expect(aFailed!.status).toBe("failed");

      const blocked = await pollCli(worker, `${b.taskKey} blocked by failed A`, async () => {
        const item = await queuedItem(worker, b.taskKey);
        return item?.dependencyState === "blocked" ? item : undefined;
      });
      expect(blocked.dependencyReason).toContain(a.taskKey);

      // A later task runs to completion, so the drain had ticks to start B.
      const sentinel = await add(worker, [
        "--title",
        "Sentinel after the block",
        "--body",
        "Make the greeting friendlier.",
      ]);
      const [sentinelRun] = await waitForSettledRun(worker, sentinel.taskKey);
      expect(sentinelRun!.status).toBe("succeeded");
      expect(await cliRuns(worker, b.taskKey)).toHaveLength(0);
      expect((await queuedItem(worker, b.taskKey))?.dependencyState).toBe("blocked");

      // The marker lives in the fake agent's environment, so drop it and
      // restart the worker before re-queueing A.
      await worker.stop();
      delete worker.env.E2E_FAIL_PROMPT_MARKER;
      const resumed = await add(worker, ["--resume", a.taskKey]);
      expect(resumed).toMatchObject({ taskKey: a.taskKey, status: "pending" });

      worker.start();
      await worker.waitForReady();
      const aRuns = await waitForSettledRun(worker, a.taskKey, 2);
      expect(aRuns).toHaveLength(2);
      expect(aRuns[1]!.status).toBe("succeeded");
      const [bRun] = await waitForSettledRun(worker, b.taskKey);
      expect(bRun!.status).toBe("succeeded");
      expect(bRun!.startedAt).toBeGreaterThanOrEqual(aRuns[1]!.finishedAt!);
    } finally {
      await cleanup([["worker fixture", () => worker.dispose()]]);
    }
  },
  300_000,
);
