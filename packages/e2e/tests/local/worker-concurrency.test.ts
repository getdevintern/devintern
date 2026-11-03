import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerAgentTimelineEvent, WorkerInjectedTask } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

// Comfortably larger than process/worktree startup jitter, so overlapping
// agent intervals are caused by the configured cap rather than timing.
const AGENT_DELAY_MS = 2_500;
const CANONICAL_GREETING = 'export const greeting = "Hello, world!";';

/**
 * Highest number of simultaneously open agent intervals.
 *
 * Starts sort before ends at the same millisecond so the derived peak never
 * under-reports a real overlap. Sorting real events keeps the assertion
 * deterministic; the test never samples a clock in a polling loop.
 */
function maxOverlap(events: WorkerAgentTimelineEvent[]): number {
  const rank = (event: WorkerAgentTimelineEvent): number => (event.event === "start" ? 0 : 1);
  let active = 0;
  let peak = 0;
  for (const event of [...events].sort((a, b) => a.at - b.at || rank(a) - rank(b))) {
    if (event.event === "start") {
      active += 1;
      peak = Math.max(peak, active);
    } else {
      active = Math.max(0, active - 1);
    }
  }
  return peak;
}

function diagnostics(worker: WorkerFixture, details: string[] = []): string {
  return [
    ...details,
    `agent timeline: ${JSON.stringify(worker.agentTimeline())}`,
    `agent invocations: ${JSON.stringify(worker.agentInvocations())}`,
    worker.tail(),
  ].join("\n");
}

async function enqueueTasks(worker: WorkerFixture): Promise<WorkerInjectedTask[]> {
  const tasks: WorkerInjectedTask[] = [];
  for (const index of [1, 2, 3]) {
    tasks.push(
      await worker.addTask({
        title: `Concurrency greeting ${index}`,
        body: [
          `Change the greeting to Hello, world! for concurrency task ${index}.`,
          "",
          `E2E_CONCURRENCY_MARKER_${crypto.randomUUID()}`,
        ].join("\n"),
      }),
    );
  }
  return tasks;
}

async function waitForCompleteTimeline(
  worker: WorkerFixture,
  invocations: number,
): Promise<WorkerAgentTimelineEvent[]> {
  try {
    return await worker.waitFor(
      "the agent timeline to contain every start and end event",
      () => {
        const events = worker.agentTimeline();
        const starts = events.filter((event) => event.event === "start").length;
        const ends = events.filter((event) => event.event === "end").length;
        return starts === invocations && ends === invocations ? events : undefined;
      },
      15_000,
    );
  } catch (error) {
    // An incomplete stream means a child crashed or was killed. Fail with the
    // timeline and worker tail instead of computing an overlap from bad data.
    throw new Error(`${(error as Error).message}\n${diagnostics(worker)}`);
  }
}

async function expectSettledSuccess(
  worker: WorkerFixture,
  task: WorkerInjectedTask,
): Promise<void> {
  const { task: settled, runs } = await worker.waitForSettled(task.id);
  const details = diagnostics(worker, [
    `injected task #${task.id} (${task.task_key}) settled as "${settled.status}": ${
      settled.message ?? "no message"
    }`,
    `runs: ${JSON.stringify(runs)}`,
  ]);
  expect(settled.status, details).toBe("done");
  expect(runs, details).toHaveLength(1);
  expect(runs[0]?.status, details).toBe("succeeded");
}

async function expectPushedGreeting(
  worker: WorkerFixture,
  tasks: WorkerInjectedTask[],
): Promise<void> {
  for (const task of tasks) {
    const branch = `feature/${task.task_key}`;
    expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(CANONICAL_GREETING);
  }
}

cliTest(
  "the worker runs no more than max_concurrency injected tasks at once",
  async () => {
    const worker = new WorkerFixture({ maxConcurrency: 2, maxConcurrencyPerRepo: 2 });
    worker.env.E2E_AGENT_DELAY_MS = String(AGENT_DELAY_MS);
    try {
      await worker.prepare();
      // Enqueue before startup: the injection-only workspace stays alive
      // because work is pending, and the three rows are ready together.
      const tasks = await enqueueTasks(worker);
      worker.start();
      await worker.waitForReady();

      await Promise.all(tasks.map((task) => expectSettledSuccess(worker, task)));
      const events = await waitForCompleteTimeline(worker, tasks.length);
      const peak = maxOverlap(events);

      // Exactly two proves the global cap is enforced and that work is not
      // accidentally serialized (peak > 1) or over-admitted (peak === 3).
      expect(peak, diagnostics(worker, [`observed peak overlap: ${peak}`])).toBe(2);

      await expectPushedGreeting(worker, tasks);
      await worker.waitFor("the successful runs' worktrees to be removed", () =>
        worker.taskWorktrees().length === 0 ? true : undefined,
      );
      expect(worker.taskWorktrees()).toEqual([]);
      expect(worker.running, diagnostics(worker)).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // Comfortably above prepare + 20s readiness + three 2.5s agent runs +
  // settle/worktree bounds + the helper's 25s SIGTERM and 5s SIGKILL.
  180_000,
);

cliTest(
  "the worker runs only one injected task at a time per repository",
  async () => {
    const worker = new WorkerFixture({ maxConcurrency: 3, maxConcurrencyPerRepo: 1 });
    worker.env.E2E_AGENT_DELAY_MS = String(AGENT_DELAY_MS);
    try {
      await worker.prepare();
      const tasks = await enqueueTasks(worker);
      worker.start();
      await worker.waitForReady();

      await Promise.all(tasks.map((task) => expectSettledSuccess(worker, task)));
      const events = await waitForCompleteTimeline(worker, tasks.length);
      const peak = maxOverlap(events);

      // The global cap allows three, so a peak of one isolates the per-repo
      // cap: the same repository never had two agent intervals open.
      expect(peak, diagnostics(worker, [`observed peak overlap: ${peak}`])).toBe(1);

      // Corroborate with the durable rows: each claim settles before the next
      // task in the same repo is claimed, so no worktree/run was admitted in
      // parallel behind the agent timeline.
      const rows = tasks
        .map((task) => worker.injectedTask(task.id))
        .sort((a, b) => (a?.started_at ?? 0) - (b?.started_at ?? 0));
      for (let index = 1; index < rows.length; index += 1) {
        const previous = rows[index - 1]!;
        const current = rows[index]!;
        expect(current.started_at, diagnostics(worker)).not.toBeNull();
        expect(previous.finished_at, diagnostics(worker)).not.toBeNull();
        expect(
          current.started_at!,
          diagnostics(worker, [`injected rows: ${JSON.stringify(rows)}`]),
        ).toBeGreaterThanOrEqual(previous.finished_at!);
      }

      await expectPushedGreeting(worker, tasks);
      await worker.waitFor("the successful runs' worktrees to be removed", () =>
        worker.taskWorktrees().length === 0 ? true : undefined,
      );
      expect(worker.taskWorktrees()).toEqual([]);
      expect(worker.running, diagnostics(worker)).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // Three serial 2.5s agent runs plus the helper's bounded waits.
  180_000,
);
