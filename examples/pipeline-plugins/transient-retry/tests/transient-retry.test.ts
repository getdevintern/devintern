import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import definition from "../plugin";
import { createTestContext, makeTempDir, removeTempDir, runDefinition } from "../../shared/harness";

let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("transient-retry-example-");
});

afterEach(() => {
  removeTempDir(workdir);
});

function attempts(statePath: string): number {
  return JSON.parse(readFileSync(join(workdir, statePath), "utf8")).attempts;
}

describe("transient-retry plugin", () => {
  test("retries a transient StepExecutionError once and then succeeds", async () => {
    const context = createTestContext({ workingDir: workdir });
    const outcome = await runDefinition(definition, context, {
      config: { failures: 1, statePath: "state.json" },
    });

    expect(outcome.kind).toBe("completed");
    expect(attempts("state.json")).toBe(2);
  });

  test("halts when the transient failure persists past the single retry", async () => {
    const context = createTestContext({ workingDir: workdir });
    const outcome = await runDefinition(definition, context, {
      config: { failures: 2, statePath: "state.json" },
    });

    expect(outcome.kind).toBe("halted");
    if (outcome.kind !== "halted") throw new Error("expected the pipeline to halt");
    expect(outcome.reason).toContain("Transient remote check failed");
    expect(attempts("state.json")).toBe(2);
  });

  test("a permanent finding halts immediately without a retry", async () => {
    const context = createTestContext({ workingDir: workdir });
    const outcome = await runDefinition(definition, context, {
      config: { permanentFailure: true, statePath: "state.json" },
    });

    expect(outcome.kind).toBe("halted");
    if (outcome.kind !== "halted") throw new Error("expected the pipeline to halt");
    expect(outcome.reason).toContain("no retry");
  });
});
