import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const taskKey = "e2e-working-window";
const pollIntervalSeconds = 1;
const pollIntervalMs = pollIntervalSeconds * 1_000;

/** Format minutes after midnight as the `HH:MM` the schedule parser expects. */
function formatUtcMinutes(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1_440) + 1_440) % 1_440;
  const hours = String(Math.floor(normalized / 60)).padStart(2, "0");
  const minutes = String(normalized % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** A one-hour daily window starting `startMinutes` after UTC midnight. */
function utcWindow(startMinutes: number): string {
  return `${formatUtcMinutes(startMinutes)}-${formatUtcMinutes(startMinutes + 60)}`;
}

/** Ready Markdown task carrying the prompt the deterministic agent expects. */
function markdownTask(marker: string): string {
  return [
    "---",
    `key: ${taskKey}`,
    "status: todo",
    "---",
    "# Expand the greeting",
    "",
    "Change the greeting to Hello, world! and run bun test.",
    "",
    marker,
    "",
  ].join("\n");
}

test.skipIf(!existsSync(cliPath))(
  "the worker defers a ready task outside its working window and run-now drains it once",
  async () => {
    // Unique per run: the deterministic agent refuses to edit unless this exact
    // string reaches its prompt, proving the ready Markdown task was selected
    // instead of some other file.
    const marker = `E2E_DESCRIPTION_MARKER_${crypto.randomUUID()}`;
    const now = new Date();
    const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    // Two windows starting well after the current UTC minute: pickup is closed
    // now, and the explicit timezone keeps the fixture deterministic.
    const activeWindows = [utcWindow(nowMinutes + 120), utcWindow(nowMinutes + 180)];
    const worker = new WorkerFixture({
      env: { E2E_EXPECT_DESCRIPTION_MARKER: marker },
      workspaceTomlExtra: [
        'task_query = "status=todo"',
        `poll_interval = ${pollIntervalSeconds}`,
        "",
        "[worker.schedule]",
        `active = ["${activeWindows[0]}", "${activeWindows[1]}"]`,
        'timezone = "UTC"',
        "catch_up_missed = false",
      ].join("\n"),
    });
    const tasksDir = join(worker.root, "markdown-tasks");
    const taskFile = join(tasksDir, `${taskKey}.md`);
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(taskFile, markdownTask(marker));
    worker.env.MARKDOWN_TASKS_DIR = tasksDir;
    const branch = `feature/${taskKey}`;
    try {
      await worker.prepare();
      worker.start();
      await worker.waitForReady();
      // Readiness only arms the injected drain; wait for the Markdown polling
      // acquirer and the working-window banner before asserting on its gate.
      await worker.waitForOutput(
        /🔎 Polling markdown every 1s \(query: status=todo\)/,
        20_000,
        "markdown polling startup",
      );
      await worker.waitForOutput(/🕒 Working windows \(UTC\): active /);
      await worker.waitForOutput(/🌙 New-task pickup is paused until /);

      // Bounded polling across two full poll intervals: the ready task must
      // never reach the agent while the working window is closed.
      const quietDeadline = Date.now() + 2 * pollIntervalMs + 1_000;
      while (Date.now() < quietDeadline) {
        expect(worker.runRecords(taskKey)).toHaveLength(0);
        expect(worker.agentInvocations()).toHaveLength(0);
        expect(worker.running, worker.tail()).toBe(true);
        await Bun.sleep(100);
      }

      const runNow = await worker.runRunNow([
        "--workspace",
        join(worker.workspaceDir, "workspace.toml"),
      ]);
      expect(runNow.exitCode, runNow.stderr).toBe(0);
      expect(runNow.stdout).toContain(worker.runNowPath);

      await worker.waitForOutput(
        new RegExp(`📌 \\[poll:markdown\\] picking up ${taskKey}`),
        60_000,
        "markdown task pickup",
      );
      const runs = await worker.waitFor(
        "the ready Markdown task run to settle",
        () => {
          const records = worker.runRecords(taskKey);
          const run = records[0];
          if (!run || run.status === "in_progress") return undefined;
          return records;
        },
        60_000,
      );

      expect(runs, worker.tail()).toHaveLength(1);
      expect(runs[0]?.status, worker.tail()).toBe("succeeded");
      expect(runs[0]?.branch).toBe(branch);
      expect(worker.agentInvocations()).toEqual([{ mode: "implement" }]);
      expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      const changedFiles = await checkedCommand(
        [
          "git",
          "--git-dir",
          worker.remote,
          "diff",
          "--name-only",
          `${worker.baseBranch}...${branch}`,
        ],
        worker.root,
        worker.env,
      );
      expect(changedFiles.split("\n").filter(Boolean)).toEqual(["src/greeting.ts"]);

      // The gate consumes the sentinel before the drain, and the drain must
      // delete it rather than leaving a permanent override behind.
      await worker.waitFor("the .run-now marker to be consumed", () =>
        existsSync(worker.runNowPath) ? undefined : true,
      );
      expect(existsSync(worker.runNowPath)).toBe(false);
      expect(worker.running, worker.tail()).toBe(true);

      // Successful Markdown runs move the file to Done and record it as
      // actioned. Wait for that real write, then poll two more intervals to
      // prove the same task does not get a second run.
      await worker.waitFor("the Markdown task to be marked Done", () =>
        /^status:\s*Done$/m.test(readFileSync(taskFile, "utf8")) ? true : undefined,
      );
      const noReplayDeadline = Date.now() + 2 * pollIntervalMs + 1_000;
      while (Date.now() < noReplayDeadline) {
        expect(worker.runRecords(taskKey)).toHaveLength(1);
        expect(worker.agentInvocations()).toHaveLength(1);
        expect(worker.running, worker.tail()).toBe(true);
        await Bun.sleep(100);
      }

      // Cheap negative: a workspace path without workspace.toml must fail
      // before creating a sentinel in that directory.
      const missingDir = join(worker.root, "missing-workspace");
      mkdirSync(missingDir, { recursive: true });
      const missing = await worker.runRunNow(["--workspace", join(missingDir, "workspace.toml")]);
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr).toContain("No workspace.toml");
      expect(existsSync(join(missingDir, ".run-now"))).toBe(false);
      expect(existsSync(worker.runNowPath)).toBe(false);
    } finally {
      await worker.dispose();
    }
  },
  // Must exceed the helper's worst case: 20s readiness + 60s pickup/settle +
  // 25s SIGTERM + 5s SIGKILL, plus prepare() and daemon work.
  180_000,
);
