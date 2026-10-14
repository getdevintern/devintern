import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PipelineContext, TaskStep, TaskStepResult } from "@getdevintern/code/pipeline";

import definition from "../plugin";
import { createTestContext, makeTempDir, removeTempDir, runDefinition } from "../../shared/harness";

let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("verify-artifacts-example-");
});

afterEach(() => {
  removeTempDir(workdir);
});

function writeArtifact(contents: unknown): void {
  mkdirSync(join(workdir, "dist"), { recursive: true });
  writeFileSync(join(workdir, "dist", "report.json"), JSON.stringify(contents, null, 2));
}

describe("verify-artifacts plugin", () => {
  test("continues on a valid artifact and exposes it as structured data", async () => {
    writeArtifact({ version: "1.0.0", checks: ["lint", "test"] });
    const context = createTestContext({ workingDir: workdir });

    let observed: unknown;
    const inspect: TaskStep<PipelineContext> = {
      name: "inspect-artifact",
      run: async (current): Promise<TaskStepResult> => {
        const record = current.results.find((entry) => entry.step === "verify-artifacts");
        observed = (record?.result as { data?: unknown })?.data;
        return { kind: "continue" };
      },
    };

    const outcome = await runDefinition(definition, context, {
      config: { path: "dist/report.json", requiredFields: ["version", "checks"] },
      after: [inspect],
    });

    expect(outcome.kind).toBe("completed");
    expect(observed).toMatchObject({ artifact: { version: "1.0.0", checks: ["lint", "test"] } });
  });

  test("halts when the artifact is missing", async () => {
    const context = createTestContext({ workingDir: workdir });
    const outcome = await runDefinition(definition, context, {
      config: { path: "dist/report.json", requiredFields: ["version", "checks"] },
    });

    expect(outcome.kind).toBe("halted");
    if (outcome.kind !== "halted") throw new Error("expected the pipeline to halt");
    expect(outcome.reason).toContain("missing");
  });

  test("halts when a required field is absent", async () => {
    writeArtifact({ version: "1.0.0" });
    const context = createTestContext({ workingDir: workdir });
    const outcome = await runDefinition(definition, context, {
      config: { path: "dist/report.json", requiredFields: ["version", "checks"] },
    });

    expect(outcome.kind).toBe("halted");
    if (outcome.kind !== "halted") throw new Error("expected the pipeline to halt");
    expect(outcome.reason).toContain("checks");
  });

  test("halts on malformed JSON", async () => {
    mkdirSync(join(workdir, "dist"), { recursive: true });
    writeFileSync(join(workdir, "dist", "report.json"), "{ not json");
    const context = createTestContext({ workingDir: workdir });
    const outcome = await runDefinition(definition, context, {
      config: { path: "dist/report.json" },
    });
    expect(outcome.kind).toBe("halted");
  });
});
