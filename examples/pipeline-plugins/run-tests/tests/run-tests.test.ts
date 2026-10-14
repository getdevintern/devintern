import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import definition from "../plugin";
import { createTestContext, makeTempDir, removeTempDir, runDefinition } from "../../shared/harness";

let workdir: string;
const fixtureDir = join(import.meta.dir, "..", "fixtures", "sample");

beforeEach(() => {
  workdir = makeTempDir("run-tests-example-");
});

afterEach(() => {
  removeTempDir(workdir);
});

describe("run-tests plugin", () => {
  test("continues when the configured command exits zero", async () => {
    const context = createTestContext({ workingDir: workdir });
    const outcome = await runDefinition(definition, context, {
      config: { args: ["test", "./pass.fixture.ts"], cwd: fixtureDir },
    });

    expect(outcome.kind).toBe("completed");
    expect(context.results.at(-1)?.result).toMatchObject({
      kind: "continue",
      data: { exitCode: 0 },
    });
  });

  test("halts with actionable, bounded diagnostics when the command fails", async () => {
    const context = createTestContext({ workingDir: workdir });
    const outcome = await runDefinition(definition, context, {
      config: { args: ["test", "./fail.fixture.ts"], cwd: fixtureDir, maxDiagnosticsBytes: 200 },
    });

    expect(outcome.kind).toBe("halted");
    if (outcome.kind !== "halted") throw new Error("expected the pipeline to halt");
    expect(outcome.reason).toContain("failed with exit code 1");
    expect(outcome.reason).toContain("Fix the failure");
    expect(outcome.reason.length).toBeLessThan(2_000);
  });

  test("warn mode records the failure without halting", async () => {
    const context = createTestContext({ workingDir: workdir });
    const outcome = await runDefinition(definition, context, {
      config: { args: ["test", "./fail.fixture.ts"], cwd: fixtureDir, onFail: "warn" },
    });

    expect(outcome.kind).toBe("completed");
    expect(context.warnings.some((warning) => warning.includes("run-tests"))).toBe(true);
  });
});
