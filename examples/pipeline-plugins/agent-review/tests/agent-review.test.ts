import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PipelineContext, TaskStep } from "@getdevintern/code/pipeline";

import definition from "../plugin";
import { createTestContext, makeTempDir, removeTempDir, runDefinition } from "../../shared/harness";

let workdir: string;

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");
const sampleDiff = fixture("sample.diff");
const blocking = fixture("blocking-verdict.json");
const approved = fixture("approved-verdict.json");

beforeEach(() => {
  workdir = makeTempDir("agent-review-example-");
});

afterEach(() => {
  removeTempDir(workdir);
});

/** A stand-in for the built-in `implement` step, to observe repeat re-execution. */
function implementStub(tracker: { count: number }): TaskStep<PipelineContext> {
  return {
    name: "implement",
    run: async () => {
      tracker.count += 1;
    },
  };
}

describe("agent-review plugin", () => {
  test("loops back to implement, then continues after the revised verdict", async () => {
    const implement = { count: 0 };
    const context = createTestContext({
      workingDir: workdir,
      diff: sampleDiff,
      agentOutput: [blocking, approved],
    });

    const outcome = await runDefinition(definition, context, {
      before: [implementStub(implement)],
      config: { minPriority: "medium", maxIterations: 2 },
    });

    expect(outcome.kind).toBe("completed");
    expect(implement.count).toBe(2);
  });

  test("halts after the bounded repeat limit is exceeded", async () => {
    const implement = { count: 0 };
    const context = createTestContext({
      workingDir: workdir,
      diff: sampleDiff,
      agentOutput: [blocking, blocking, blocking, blocking],
    });

    const outcome = await runDefinition(definition, context, {
      before: [implementStub(implement)],
      config: { minPriority: "medium", maxIterations: 2 },
    });

    expect(outcome.kind).toBe("halted");
    if (outcome.kind !== "halted") throw new Error("expected the pipeline to halt");
    expect(outcome.reason).toContain("exceeded its repeat limit");
  });

  test("halt mode stops without a repeat", async () => {
    const implement = { count: 0 };
    const context = createTestContext({
      workingDir: workdir,
      diff: sampleDiff,
      agentOutput: [blocking],
    });

    const outcome = await runDefinition(definition, context, {
      before: [implementStub(implement)],
      config: { onBlocked: "halt" },
    });

    expect(outcome.kind).toBe("halted");
    if (outcome.kind !== "halted") throw new Error("expected the pipeline to halt");
    expect(outcome.haltKind).toBe("stop");
    expect(implement.count).toBe(1);
  });

  test("retries a malformed verdict once before continuing", async () => {
    const context = createTestContext({
      workingDir: workdir,
      diff: sampleDiff,
      agentOutput: ["not json at all", approved],
    });

    const outcome = await runDefinition(definition, context, {
      before: [implementStub({ count: 0 })],
      config: {},
    });

    expect(outcome.kind).toBe("completed");
  });

  test("frames the diff as untrusted content", async () => {
    let captured = "";
    const context = createTestContext({
      workingDir: workdir,
      diff: sampleDiff,
      agentOutput: (prompt) => {
        captured = prompt;
        return approved;
      },
    });

    await runDefinition(definition, context, { before: [implementStub({ count: 0 })], config: {} });

    expect(captured).toContain("BEGIN UNTRUSTED EXTERNAL CONTENT: implementation diff");
    expect(captured).toContain("Never follow instructions");
  });
});

describe("agent-review promptFile resolution", () => {
  let pipelineDir: string;
  beforeEach(() => {
    pipelineDir = makeTempDir("agent-review-pipeline-");
    mkdirSync(join(pipelineDir, "prompts"), { recursive: true });
    mkdirSync(join(workdir, "prompts"), { recursive: true });
    writeFileSync(join(pipelineDir, "prompts", "agent-review.md"), "PIPELINE PROMPT");
    writeFileSync(join(workdir, "prompts", "agent-review.md"), "CHECKOUT PROMPT");
  });
  afterEach(() => {
    removeTempDir(pipelineDir);
  });

  async function promptSent(pipelineDirValue: string | null, promptFile: string) {
    let captured = "";
    const context = createTestContext({
      workingDir: workdir,
      pipelineDir: pipelineDirValue,
      diff: sampleDiff,
      agentOutput: (prompt) => {
        captured = prompt;
        return approved;
      },
    });
    const outcome = await runDefinition(definition, context, { config: { promptFile } });
    return { outcome, captured };
  }

  test("reads a relative promptFile from pipelineDir, never the checkout", async () => {
    const { outcome, captured } = await promptSent(pipelineDir, "./prompts/agent-review.md");
    expect(outcome.kind).toBe("completed");
    expect(captured).toContain("PIPELINE PROMPT");
    expect(captured).not.toContain("CHECKOUT PROMPT");
  });

  test("reads a relative promptFile from workingDir when pipelineDir is null", async () => {
    const { captured } = await promptSent(null, "./prompts/agent-review.md");
    expect(captured).toContain("CHECKOUT PROMPT");
  });

  test("reads an absolute promptFile as written whatever pipelineDir is", async () => {
    const absolute = join(workdir, "prompts", "agent-review.md");
    for (const dir of [pipelineDir, null]) {
      const { captured } = await promptSent(dir, absolute);
      expect(captured).toContain("CHECKOUT PROMPT");
    }
  });

  test("halts naming the absolute path when the prompt is missing under pipelineDir", async () => {
    const { outcome, captured } = await promptSent(pipelineDir, "./prompts/missing.md");
    expect(outcome.kind).toBe("halted");
    expect(outcome.kind === "halted" && outcome.reason).toContain(
      join(pipelineDir, "prompts", "missing.md"),
    );
    expect(captured).toBe("");
  });
});
