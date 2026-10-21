import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cliPath, WorkerFixture } from "../../helpers/worker";

test.skipIf(!existsSync(cliPath))(
  "the worker daemon drains an injected task, pushes the fixture branch and cleans up",
  async () => {
    const worker = new WorkerFixture();
    // Unique per run: the deterministic agent refuses to edit unless this exact
    // string reaches its prompt, proving `worker add` delivered the enqueued
    // title/body instead of some other markdown task file in the repo.
    const marker = `E2E_DESCRIPTION_MARKER_${crypto.randomUUID()}`;
    worker.env.E2E_EXPECT_DESCRIPTION_MARKER = marker;
    try {
      await worker.prepare();
      // Enqueue before startup: the injection-only workspace is kept alive by
      // the pending task, exercising the worker's documented exception path.
      const task = await worker.addTask({
        title: "Expand the greeting",
        body: `Change the greeting to Hello, world! and run bun test.\n\n${marker}`,
      });
      worker.start();
      await worker.waitForReady();

      const { task: settled, runs } = await worker.waitForSettled(task.id);
      const diagnostics = () =>
        [
          `injected task #${task.id} (${task.task_key}) settled as "${settled.status}": ${
            settled.message ?? "no message"
          }`,
          `runs: ${JSON.stringify(runs)}`,
          worker.tail(),
        ].join("\n");

      expect(settled.status, diagnostics()).toBe("done");
      expect(runs, diagnostics()).toHaveLength(1);
      expect(runs[0]?.status, diagnostics()).toBe("succeeded");
      expect(worker.agentInvocations()).toEqual([{ mode: "implement" }]);
      // The daemon must outlive the run: a worker that exits after writing
      // `done` would satisfy every row/run assertion above without draining.
      expect(worker.running, diagnostics()).toBe(true);

      const branch = `feature/${task.task_key}`;
      expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );

      await worker.waitFor("the successful run's worktree to be removed", () =>
        worker.taskWorktrees().length === 0 ? true : undefined,
      );
      expect(worker.taskWorktrees()).toEqual([]);
      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // Must exceed the helper's worst case: 20s readiness + 45s settle + 30s
  // worktree wait + 25s SIGTERM + 5s SIGKILL, plus prepare() and daemon work.
  180_000,
);
