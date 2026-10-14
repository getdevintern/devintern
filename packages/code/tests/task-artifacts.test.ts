import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  listTaskArtifacts,
  readTaskArtifact,
  TASK_ARTIFACT_MAX_FILES,
} from "../src/lib/observability/task-artifacts";

describe("task artifacts", () => {
  let base: string;
  let savedOutputDir: string | undefined;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "task-artifacts-"));
    savedOutputDir = process.env.DEVINTERN_OUTPUT_DIR;
    process.env.DEVINTERN_OUTPUT_DIR = base;
  });

  afterEach(() => {
    if (savedOutputDir === undefined) delete process.env.DEVINTERN_OUTPUT_DIR;
    else process.env.DEVINTERN_OUTPUT_DIR = savedOutputDir;
    rmSync(base, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const path = join(base, "dev-1", rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  test("returns [] for a missing task directory", () => {
    expect(listTaskArtifacts("DEV-1")).toEqual([]);
  });

  test("lists artifacts recursively, sorted by relative path", () => {
    write("verify-prompt.txt", "prompt");
    write("verify-feedback.json", "{}");
    write("iteration-1/feedback.json", "{}");
    write("pr-explanation.md", "# hi");

    expect(listTaskArtifacts("DEV-1").map((file) => file.name)).toEqual([
      "iteration-1/feedback.json",
      "pr-explanation.md",
      "verify-feedback.json",
      "verify-prompt.txt",
    ]);
  });

  test("reads artifact content stripped of ANSI codes and redacted", () => {
    write("verify-prompt.txt", "\u001b[31mtoken\u001b[0m=ghp_abcdefghijklmnopqrstuvwxyz\n");
    const content = readTaskArtifact("DEV-1", "verify-prompt.txt");
    expect(content?.content).toContain("token=");
    expect(content?.content).not.toContain("\u001b[31m");
    expect(content?.content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(content?.content).toContain("[redacted]");
    expect(content?.truncated).toBe(false);
  });

  test("reads nested artifacts and reports truncation", () => {
    write("iteration-1/review-prompt.txt", "x".repeat(100));
    expect(readTaskArtifact("DEV-1", "iteration-1/review-prompt.txt")?.content).toBe(
      "x".repeat(100),
    );

    const truncated = readTaskArtifact("DEV-1", "iteration-1/review-prompt.txt", { maxBytes: 10 });
    expect(truncated?.truncated).toBe(true);
    expect(truncated?.content).toBe("x".repeat(10));
    expect(truncated?.totalBytes).toBe(100);
  });

  test("rejects path traversal and unsafe names", () => {
    write("verify-prompt.txt", "ok");
    expect(readTaskArtifact("DEV-1", "../verify-prompt.txt")).toBeNull();
    expect(readTaskArtifact("DEV-1", "/etc/passwd")).toBeNull();
    expect(readTaskArtifact("DEV-1", "a/../../b")).toBeNull();
    expect(readTaskArtifact("DEV-1", "a\\b")).toBeNull();
    expect(readTaskArtifact("DEV-1", "")).toBeNull();
  });

  test("returns null for a missing artifact", () => {
    expect(readTaskArtifact("DEV-1", "nope.md")).toBeNull();
  });

  test("honors a directory override", () => {
    const dir = join(base, "custom");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.txt"), "hi");

    expect(listTaskArtifacts("ignored", { dir }).map((file) => file.name)).toEqual(["a.txt"]);
    expect(readTaskArtifact("ignored", "a.txt", { dir })?.content).toBe("hi");
  });

  test("caps the number of listed files", () => {
    for (let i = 0; i < 5; i++) write(`f-${i}.txt`, "x");
    expect(listTaskArtifacts("DEV-1", { limit: 3 })).toHaveLength(3);
  });

  test("skips symlinks", () => {
    if (process.platform === "win32") return;
    write("real.txt", "real");
    symlinkSync(join(base, "dev-1", "real.txt"), join(base, "dev-1", "link.txt"));

    expect(listTaskArtifacts("DEV-1").map((file) => file.name)).toEqual(["real.txt"]);
  });

  test("exports a positive listing cap", () => {
    expect(TASK_ARTIFACT_MAX_FILES).toBeGreaterThan(0);
  });
});
