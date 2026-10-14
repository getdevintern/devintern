import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import definition, { addedFilesFromDiff } from "../plugin";
import { createTestContext, makeTempDir, removeTempDir, runDefinition } from "../../shared/harness";

let workdir: string;
const sampleDiff = readFileSync(join(import.meta.dir, "..", "fixtures", "sample.diff"), "utf8");

beforeEach(() => {
  workdir = makeTempDir("check-policy-example-");
});

afterEach(() => {
  removeTempDir(workdir);
});

describe("check-policy plugin", () => {
  test("findings from a tasteful example diff", () => {
    expect(addedFilesFromDiff(sampleDiff).sort()).toEqual(["docs/notes.md", "secrets/prod.key"]);
  });

  test("continues when no newly added file is forbidden", async () => {
    const context = createTestContext({ workingDir: workdir, diff: sampleDiff });
    const outcome = await runDefinition(definition, context, {
      config: { forbiddenPaths: ["generated/"] },
    });

    expect(outcome.kind).toBe("completed");
    expect(context.results.at(-1)?.result).toMatchObject({ kind: "continue" });
  });

  test("halts on a forbidden added file with actionable findings", async () => {
    const context = createTestContext({ workingDir: workdir, diff: sampleDiff });
    const outcome = await runDefinition(definition, context, {
      config: { forbiddenPaths: ["secrets/"] },
    });

    expect(outcome.kind).toBe("halted");
    if (outcome.kind !== "halted") throw new Error("expected the pipeline to halt");
    expect(outcome.reason).toContain("secrets/prod.key");
    expect(outcome.reason).toContain("forbidden path");
    const record = context.results.at(-1)?.result;
    expect(record).toMatchObject({
      kind: "halt",
      data: { findings: [{ path: "secrets/prod.key" }] },
    });
  });

  test("warn mode records advisory findings without halting", async () => {
    const context = createTestContext({ workingDir: workdir, diff: sampleDiff });
    const outcome = await runDefinition(definition, context, {
      config: { forbiddenPaths: ["secrets/"], onFail: "warn" },
    });

    expect(outcome.kind).toBe("completed");
    expect(context.warnings.some((warning) => warning.includes("secrets/prod.key"))).toBe(true);
  });
});
