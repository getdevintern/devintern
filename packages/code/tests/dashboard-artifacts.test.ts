import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  DashboardData,
  handleRunArtifact,
  handleRunArtifacts,
  handleRunDetail,
} from "../src/lib/observability/dashboard-api";
import { RunStore } from "../src/lib/state/run-recorder";

describe("dashboard task artifacts", () => {
  let dir: string;
  let outputDir: string;
  let dbPath: string;
  let data: DashboardData;
  let savedOutputDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dash-artifacts-"));
    outputDir = mkdtempSync(join(tmpdir(), "dash-artifacts-out-"));
    savedOutputDir = process.env.DEVINTERN_OUTPUT_DIR;
    process.env.DEVINTERN_OUTPUT_DIR = outputDir;
    dbPath = join(dir, "queue.db");
    data = new DashboardData({ dbPath, workingDir: dir });
  });

  afterEach(() => {
    data.close();
    if (savedOutputDir === undefined) delete process.env.DEVINTERN_OUTPUT_DIR;
    else process.env.DEVINTERN_OUTPUT_DIR = savedOutputDir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  });

  function seedArtifact(taskKey: string, rel: string, content: string): void {
    const path = join(outputDir, taskKey.toLowerCase(), rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function seedRun(taskKey?: string): number {
    const store = new RunStore(dbPath);
    const runId = store.createRun({ origin: "task", taskKey, harness: "claude-code" });
    store.close();
    return runId;
  }

  test("run detail lists the run's artifacts attributed to its task key", () => {
    seedArtifact("DEV-128", "verify-prompt.txt", "prompt");
    seedArtifact("DEV-128", "pr-explanation.md", "# Explanation");
    const runId = seedRun("DEV-128");

    const response = handleRunDetail(data, String(runId));
    expect(response.status).toBe(200);
    const body = response.body as { artifacts: { name: string }[] };
    expect(body.artifacts.map((file) => file.name)).toEqual([
      "pr-explanation.md",
      "verify-prompt.txt",
    ]);
  });

  test("lists artifacts as JSON for a run", () => {
    seedArtifact("DEV-128", "iteration-1/feedback.json", "{}");
    const runId = seedRun("DEV-128");

    const response = handleRunArtifacts(data, String(runId));
    expect(response.status).toBe(200);
    const body = response.body as { artifacts: { name: string }[] };
    expect(body.artifacts.map((file) => file.name)).toEqual(["iteration-1/feedback.json"]);
  });

  test("serves a redacted artifact scoped to its run", () => {
    seedArtifact("DEV-128", "verify-prompt.txt", "token=ghp_abcdefghijklmnopqrstuvwxyz\n");
    const runId = seedRun("DEV-128");

    const response = handleRunArtifact(
      data,
      String(runId),
      encodeURIComponent("verify-prompt.txt"),
    );
    expect(response.status).toBe(200);
    const body = response.body as { content: string };
    expect(body.content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(body.content).toContain("[redacted]");
  });

  test("serves a nested artifact path", () => {
    seedArtifact("DEV-128", "iteration-1/review-prompt.txt", "review");
    const runId = seedRun("DEV-128");

    const response = handleRunArtifact(
      data,
      String(runId),
      encodeURIComponent("iteration-1/review-prompt.txt"),
    );
    expect(response.status).toBe(200);
    expect((response.body as { content: string }).content).toBe("review");
  });

  test("does not serve an artifact that is not in the run's directory", () => {
    seedArtifact("DEV-999", "other.txt", "other");
    const runId = seedRun("DEV-128");

    expect(
      handleRunArtifact(data, String(runId), encodeURIComponent("../dev-999/other.txt")).status,
    ).toBe(404);
    expect(handleRunArtifact(data, String(runId), encodeURIComponent("other.txt")).status).toBe(
      404,
    );
  });

  test("a run without a task key has no artifacts", () => {
    const runId = seedRun(undefined);
    const response = handleRunArtifacts(data, String(runId));
    expect(response.status).toBe(200);
    expect((response.body as { artifacts: unknown[] }).artifacts).toEqual([]);
  });

  test("404s for an unknown run and 400s for an invalid id", () => {
    expect(handleRunArtifacts(data, "99999").status).toBe(200);
    expect(handleRunArtifact(data, "99999", "verify-prompt.txt").status).toBe(404);
    expect(handleRunArtifacts(data, "abc").status).toBe(400);
    expect(handleRunArtifact(data, "abc", "verify-prompt.txt").status).toBe(400);
  });
});
