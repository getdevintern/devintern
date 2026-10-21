import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cliPath, WorkerFixture } from "../../helpers/worker";

test.skipIf(!existsSync(cliPath))(
  "the worker daemon drains an injected task, pushes the fixture branch and cleans up",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      worker.start();
      await worker.waitForReady();

      const task = await worker.addTask({
        title: "Expand the greeting",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      const { task: settled, runs } = await worker.waitForSettled(task.id);

      expect(settled.status).toBe("done");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("succeeded");

      const branch = `feature/${task.task_key}`;
      expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );

      await worker.waitFor("the successful run's worktree to be removed", () =>
        worker.taskWorktrees().length === 0 ? true : undefined,
      );
      expect(worker.taskWorktrees()).toEqual([]);
    } finally {
      await worker.dispose();
    }
  },
  60_000,
);
