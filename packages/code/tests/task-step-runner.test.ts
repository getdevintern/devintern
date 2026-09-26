import { describe, expect, test } from "bun:test";
import { runTaskSteps } from "../src/lib/task/step-runner";
import type { TaskStep } from "../src/lib/task/step-runner";

describe("runTaskSteps", () => {
  test("runs phases in order with one shared context", async () => {
    const context = { visited: [] as string[] };
    const steps: TaskStep<typeof context>[] = [
      {
        name: "branch",
        run: async (ctx) => {
          ctx.visited.push("branch");
        },
      },
      {
        name: "feasibility",
        run: async (ctx) => {
          ctx.visited.push("feasibility");
        },
      },
      {
        name: "implement",
        run: async (ctx) => {
          ctx.visited.push("implement");
        },
      },
    ];

    expect(await runTaskSteps(steps, context)).toEqual({ kind: "completed" });
    expect(context.visited).toEqual(["branch", "feasibility", "implement"]);
  });

  test("repeats from an earlier phase, then continues", async () => {
    const context = { attempts: 0, visited: [] as string[] };
    const steps: TaskStep<typeof context>[] = [
      {
        name: "implement",
        run: async (ctx) => {
          ctx.attempts++;
          ctx.visited.push("implement");
        },
      },
      {
        name: "verify",
        run: async (ctx) => {
          ctx.visited.push("verify");
          return ctx.attempts === 1
            ? { kind: "repeat" as const, from: "implement", maxRepeats: 2 }
            : undefined;
        },
      },
      {
        name: "finalize",
        run: async (ctx) => {
          ctx.visited.push("finalize");
        },
      },
    ];

    expect(await runTaskSteps(steps, context)).toEqual({ kind: "completed" });
    expect(context.visited).toEqual(["implement", "verify", "implement", "verify", "finalize"]);
  });

  test("halts after a step requests input", async () => {
    const context = { visited: [] as string[] };
    const steps: TaskStep<typeof context>[] = [
      { name: "check", run: async () => ({ kind: "halt", reason: "needs input" }) },
      {
        name: "implement",
        run: async (ctx) => {
          ctx.visited.push("implement");
        },
      },
    ];

    expect(await runTaskSteps(steps, context)).toEqual({
      kind: "halted",
      step: "check",
      reason: "needs input",
    });
    expect(context.visited).toEqual([]);
  });

  test("stops at the repeat bound before reaching a later phase", async () => {
    const context = { attempts: 0 };
    const steps: TaskStep<typeof context>[] = [
      {
        name: "implement",
        run: async (ctx) => {
          ctx.attempts++;
        },
      },
      {
        name: "verify",
        run: async () => ({ kind: "repeat", from: "implement", maxRepeats: 2 }),
      },
      {
        name: "finalize",
        run: async () => {
          throw new Error("should not finalize");
        },
      },
    ];

    expect(await runTaskSteps(steps, context)).toEqual({
      kind: "halted",
      step: "verify",
      reason: "Task step 'verify' exceeded its repeat limit (2)",
    });
    expect(context.attempts).toBe(3);
  });

  test("rejects duplicate names and invalid repeat targets or bounds", async () => {
    const noop = async () => {};
    await expect(
      runTaskSteps(
        [
          { name: "same", run: noop },
          { name: "same", run: noop },
        ],
        {},
      ),
    ).rejects.toThrow("unique");
    await expect(
      runTaskSteps(
        [
          { name: "first", run: async () => ({ kind: "repeat", from: "later", maxRepeats: 1 }) },
          { name: "later", run: noop },
        ],
        {},
      ),
    ).rejects.toThrow("unknown or later");
    await expect(
      runTaskSteps(
        [
          { name: "first", run: noop },
          { name: "second", run: async () => ({ kind: "repeat", from: "first", maxRepeats: 0 }) },
        ],
        {},
      ),
    ).rejects.toThrow("positive maxRepeats");
  });

  test("propagates step errors to the existing task failure handler", async () => {
    const failure = new Error("agent usage limit");
    await expect(
      runTaskSteps(
        [
          {
            name: "implement",
            run: async () => {
              throw failure;
            },
          },
        ],
        {},
      ),
    ).rejects.toBe(failure);
  });
});
