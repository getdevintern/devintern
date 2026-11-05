import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { checkedCommand } from "../../helpers/process";
import {
  cliPath,
  isProcessRunning,
  killProcessTree,
  waitForProcessesGone,
  WorkerFixture,
} from "../../helpers/worker";

/** Local offline only: relies on the freshly built CLI, no credentials. */
const cliTest = test.skipIf(!existsSync(cliPath));

/** Escape a task key so a log assertion matches it literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Hard crash → restart → failed row/no PR → manual `worker add --resume`.
 *
 * The daemon is killed with SIGKILL while a deterministic agent is provably
 * sleeping, which is the only path that leaves `injected_tasks.status` and its
 * run `in_progress` without running any shutdown hook. Automatic resume is
 * disabled so the crash must settle the row `failed` (a silent auto-resume
 * would hide the recovery decision this test exists to pin), and manual
 * `--resume` must then be able to recover the same row and push its branch.
 */
cliTest(
  "a hard-killed worker fails an interrupted injected task without a PR and `worker add --resume` recovers it",
  async () => {
    const worker = new WorkerFixture();
    // Unique per run: the row body proves recovery re-used the same enqueued
    // task instead of re-creating it (the task file carries it too).
    const marker = `E2E_ORPHAN_MARKER_${crypto.randomUUID()}`;
    // The agent must still be running when the daemon is killed, so the crash
    // lands mid-attempt rather than between steps.
    worker.env.E2E_AGENT_DELAY_MS = "30000";
    // Settle the interrupted row `failed` instead of re-queuing it silently.
    worker.env.WORKER_INJECTED_AUTO_RESUME_LIMIT = "0";
    // Every process this test may have spawned, so `finally` can kill it even
    // when an assertion fails before the fixtures are released.
    const spawned = new Set<number>();

    try {
      await worker.prepare();
      const task = await worker.addTask({
        title: "Interrupted by a hard crash",
        body: `Change the greeting to Hello, world! and run bun test.\n\n${marker}`,
      });
      worker.start();
      await worker.waitForReady();

      // Wait for the durable crash state, not a fixed delay: a started run, a
      // claimed row and a recorded detached child, with the agent already in
      // its delay (the fixture agent logs its invocation before sleeping).
      const inFlight = await worker.waitFor(
        "the injected run to start",
        () => {
          const row = worker.injectedTask(task.id);
          const run = worker.runRecords(task.task_key)[0];
          if (!row || row.status !== "running" || row.child_pid === null) return undefined;
          if (run?.status !== "in_progress") return undefined;
          if (worker.agentInvocations().length === 0) return undefined;
          return { row, run };
        },
        60_000,
      );
      const taskChildPid = inFlight.row.child_pid!;
      spawned.add(taskChildPid);
      expect(inFlight.run.branch, JSON.stringify(inFlight.run)).toBe(`feature/${task.task_key}`);

      // --- Simulate power loss: SIGKILL the daemon's whole process group. ---
      const lockedPid = worker.daemonPid();
      expect(lockedPid).toBeDefined();
      spawned.add(lockedPid!);
      const crashedDaemonPid = await worker.crash();
      expect(isProcessRunning(crashedDaemonPid)).toBe(false);
      // The lock file is left behind with the dead pid, exactly like a crash.
      expect(worker.daemonPid()).toBe(crashedDaemonPid);

      // The detached task child (and the agent it leads) outlives the daemon;
      // kill that tree so recovery sees a genuinely dead attempt.
      for (const pid of killProcessTree(taskChildPid)) spawned.add(pid);
      const survivors = await waitForProcessesGone([...spawned]);
      expect(survivors, `pids still running after the crash: ${survivors.join(", ")}`).toEqual([]);

      // The crash left the exact state startup recovery has to repair.
      const beforeRestart = worker.injectedTask(task.id);
      expect(beforeRestart?.status).toBe("running");
      expect(worker.runRecords(task.task_key)[0]?.status).toBe("in_progress");

      // --- Restart the real daemon on the same queue database. ---
      // The agent must finish promptly now; the crash's delay only had to keep
      // the first attempt alive.
      worker.env.E2E_AGENT_DELAY_MS = "0";
      // An injection-only workspace exits at startup unless it has work, so
      // enqueue a keepalive task before the restart. It also proves the worker
      // still drains after recovery instead of dying on the crashed row.
      const keepalive = await worker.addTask({
        title: "Keep the worker alive",
        body: "Make the greeting friendlier.",
      });
      // `crash()` already released the fixture's child handle.
      worker.start();
      await worker.waitForReady();

      const diagnostics = () =>
        [
          `injected task #${task.id} (${task.task_key}) is "${worker.injectedTask(task.id)?.status}": ${
            worker.injectedTask(task.id)?.message ?? "no message"
          }`,
          `runs: ${JSON.stringify(worker.runRecords(task.task_key))}`,
          worker.tail(),
        ].join("\n");

      const recovered = await worker.waitForSettled(task.id);
      expect(recovered.task.status, diagnostics()).toBe("failed");
      expect(recovered.task.message, diagnostics()).toBe(
        "worker restarted while this task was running",
      );
      // The recovery warning must name the interrupted task, not just settle
      // the row silently.
      await worker.waitForOutput(
        new RegExp(
          `injected task ${escapeRegExp(task.task_key)} was interrupted by a worker restart`,
        ),
        20_000,
        "the interrupted injected-task warning",
      );

      // Exactly one terminal, PR-less run: the restart did not silently re-run
      // the task, and the killed attempt pushed nothing.
      expect(recovered.runs, diagnostics()).toHaveLength(1);
      const crashedRun = recovered.runs[0]!;
      expect(crashedRun.status, diagnostics()).toBe("failed");
      expect(crashedRun.pr_url, diagnostics()).toBeNull();
      expect(crashedRun.branch).toBe(`feature/${task.task_key}`);
      expect(await worker.remoteBranches()).not.toContain(`feature/${task.task_key}`);

      // The disabled automatic-resume budget was never consumed, and the lock
      // was re-acquired by the replacement daemon.
      expect(recovered.task.auto_resume_count).toBe(0);
      const restartedDaemonPid = worker.daemonPid();
      expect(restartedDaemonPid).toBeDefined();
      expect(restartedDaemonPid).not.toBe(crashedDaemonPid);

      // The worker stays alive: the keepalive task drains normally.
      expect((await worker.waitForSettled(keepalive.id)).task.status).toBe("done");
      expect(worker.running, diagnostics()).toBe(true);
      expect(worker.agentInvocations()).toHaveLength(2);

      // --- Documented manual recovery: re-queue the failed row. ---
      const resumed = await worker.runAdd(["--resume", task.task_key, "--json"]);
      expect(resumed.exitCode, resumed.stderr).toBe(0);
      expect(JSON.parse(resumed.stdout.trim()) as Record<string, unknown>).toMatchObject({
        id: task.id,
        taskKey: task.task_key,
        status: "pending",
        deduplicated: false,
      });

      const finished = await worker.waitForSettled(task.id, 90_000);
      const finishedDiagnostics = () =>
        [
          `injected task #${task.id} is "${finished.task.status}": ${
            finished.task.message ?? "no message"
          }`,
          `runs: ${JSON.stringify(finished.runs)}`,
          worker.tail(),
        ].join("\n");

      expect(finished.task.status, finishedDiagnostics()).toBe("done");
      // Exactly one run was added by the resume, and the ad-hoc row (same
      // marker body and prompt file) is the one that ran: no duplicate enqueue
      // behind it.
      expect(finished.runs, finishedDiagnostics()).toHaveLength(2);
      expect(finished.runs[0]?.status).toBe("failed");
      expect(finished.task.body).toContain(marker);
      expect(readFileSync(finished.task.task_file, "utf8")).toContain(marker);
      const resumedRun = finished.runs[1]!;
      expect(resumedRun.status, finishedDiagnostics()).toBe("succeeded");
      expect(resumedRun.branch).toBeTruthy();
      // Two invocations happened before the resume (the killed attempt and the
      // keepalive); the third is the resumed run actually invoking the agent.
      expect(worker.agentInvocations()).toHaveLength(3);
      expect(await worker.remoteBranches()).toContain(resumedRun.branch!);
      expect(await worker.branchFile(resumedRun.branch!, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      const changedFiles = await checkedCommand(
        [
          "git",
          "--git-dir",
          worker.remote,
          "diff",
          "--name-only",
          worker.baseBranch,
          resumedRun.branch!,
        ],
        worker.root,
        worker.env,
      );
      expect(changedFiles.split("\n").filter(Boolean)).toEqual(["src/greeting.ts"]);
      expect(worker.running).toBe(true);
    } finally {
      // Capture child pids before `dispose()` removes the temporary root, so a
      // failed assertion cannot leak an agent or a daemon.
      for (const row of worker.injectedRows()) {
        if (typeof row.child_pid === "number") spawned.add(row.child_pid);
      }
      for (const pid of spawned) {
        if (isProcessRunning(pid)) killProcessTree(pid);
      }
      const leftovers = await waitForProcessesGone([...spawned], 5_000);
      await worker.dispose();
      if (leftovers.length > 0) {
        console.warn(`[e2e] pids still running after cleanup: ${leftovers.join(", ")}`);
      }
    }
  },
  // Must exceed the helper's worst case: 20s readiness x2 + 45s settle + 90s
  // resume settle + 25s SIGTERM + 5s SIGKILL, plus prepare() and daemon work.
  300_000,
);
