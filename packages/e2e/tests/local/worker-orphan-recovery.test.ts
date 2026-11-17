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
 * Hard crash → restart → exhausted auto-resume → manual `worker add --resume`.
 *
 * The daemon is killed with SIGKILL after the deterministic agent has landed a
 * commit and while it is provably idling, leaving `injected_tasks.status` and
 * its run `in_progress` without running any shutdown hook. The landed commit
 * makes the interrupted branch genuinely resumable, so startup recovery must
 * find it and, with automatic resume disabled, settle the row `failed` with the
 * exhausted-budget message rather than a generic interruption. Manual
 * `--resume` must then recover the same row onto the same branch.
 */
cliTest(
  "a hard-killed worker fails an interrupted injected task without a PR and `worker add --resume` recovers it",
  async () => {
    const worker = new WorkerFixture();
    // Unique per run: the row body proves recovery re-used the same enqueued
    // task instead of re-creating it (the task file carries it too).
    const marker = `E2E_ORPHAN_MARKER_${crypto.randomUUID()}`;
    // The agent must still be running when the daemon is killed, so the crash
    // lands mid-attempt rather than between steps. `interrupted` lands a commit
    // first, so startup recovery sees resumable work instead of an empty branch.
    worker.env.E2E_AGENT_MODE = "interrupted";
    worker.env.E2E_AGENT_DELAY_MS = "30000";
    // Exhaust the automatic-resume budget so the resumable row settles `failed`
    // with the actionable message instead of re-queuing itself silently.
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
      // its delay. The fixture records its invocation only after landing the
      // commit, so seeing that record also proves the branch is resumable.
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
      // The invocation record lands only after the fixture commits, so the
      // branch is already exactly one commit ahead of base. Asserting it here
      // fails loudly if that ordering regresses, instead of silently falling
      // back to the generic interruption path during recovery.
      expect(await worker.branchCommitCount(`feature/${task.task_key}`)).toBe(1);

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
      // the first attempt alive. `implement` lets the keepalive and the manual
      // resume finish the fixture change.
      worker.env.E2E_AGENT_DELAY_MS = "0";
      worker.env.E2E_AGENT_MODE = "implement";
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
      // The landed commit made the row resumable, so recovery took the
      // auto-resume path and refused only because the budget is zero. The
      // generic interruption message would mean the branch was not resumable.
      const crashedRun = recovered.runs[0]!;
      expect(recovered.task.message, diagnostics()).toContain("automatic resume budget exhausted");
      expect(recovered.task.message, diagnostics()).toContain(
        `(run #${crashedRun.id}, branch 'feature/${task.task_key}')`,
      );
      expect(recovered.task.message, diagnostics()).toContain(
        `devintern worker add --resume ${task.task_key}`,
      );
      // The recovery warning must name the interrupted task and the exhausted
      // budget, not just settle the row silently.
      await worker.waitForOutput(
        new RegExp(
          `injected task ${escapeRegExp(task.task_key)} was interrupted by a worker restart ` +
            "and its automatic resume budget is exhausted",
        ),
        20_000,
        "the interrupted injected-task warning",
      );

      // Exactly one terminal, PR-less run: the restart did not silently re-run
      // the task, and the killed attempt pushed nothing.
      expect(recovered.runs, diagnostics()).toHaveLength(1);
      expect(crashedRun.status, diagnostics()).toBe("failed");
      expect(crashedRun.pr_url, diagnostics()).toBeNull();
      expect(crashedRun.branch).toBe(`feature/${task.task_key}`);
      const interruptedBranch = crashedRun.branch!;
      expect(await worker.remoteBranches()).not.toContain(interruptedBranch);

      // The refused automatic resume did not consume the budget, and the lock
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
      // The manual resume inherited the interrupted attempt's branch (its
      // landed commit made it resumable) instead of seeding a fresh one.
      expect(resumedRun.branch).toBe(interruptedBranch);
      expect(resumedRun.attempt).toBe(2);
      // Two invocations happened before the resume (the killed attempt and the
      // keepalive); the third is the resumed run actually invoking the agent.
      expect(worker.agentInvocations()).toHaveLength(3);
      const remoteBranches = await worker.remoteBranches();
      expect(remoteBranches).toContain(interruptedBranch);
      expect(remoteBranches).not.toContain(`${interruptedBranch}-attempt-2`);
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
  // Must exceed the helper's full worst case: prepare() + 20s readiness + 60s
  // in-flight + crash 10s + 10s process reap + 20s readiness again + 45s settle
  // + 20s warning + 45s keepalive settle + 90s resume settle + 25s SIGTERM +
  // 5s SIGKILL + 5s finally reap = 355s of waits. The margin also covers
  // prepare()/git work; Bun skips `finally` on timeout, so an undersized budget
  // can leak the very daemon this test reaps.
  480_000,
);
