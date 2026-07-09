import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MarkdownTaskTrackerClient,
  type MarkdownTaskRaw,
} from "../src/lib/trackers/markdown/markdown-task-tracker-client";

function taskRaw(task: { raw: unknown }): MarkdownTaskRaw {
  return task.raw as MarkdownTaskRaw;
}

function makeTestDir(): string {
  const dir = join(tmpdir(), `md-client-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe("MarkdownTaskTrackerClient unstructured files", () => {
  test("accepts plain prose with no heading or frontmatter", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "notes.md");
    const content =
      "Implement caching for the user profile endpoint.\n\nAcceptance: p95 under 200ms.\n";
    writeFileSync(mdFile, content);

    try {
      const client = new MarkdownTaskTrackerClient({ cwd: testDir });
      const task = await client.getTask(mdFile);

      expect(task.key).toBe("notes");
      expect(task.summary).toBe("notes");
      expect(task.issueType).toBe("Task");
      expect(task.status).toBe("Unknown");
      expect(taskRaw(task).hasStatusField).toBe(false);
      expect(taskRaw(task).hasFrontmatter).toBe(false);
      expect(client.extractDescriptionText(task)).toBe(content);
    } finally {
      cleanup(testDir);
    }
  });

  test("does not treat a mid-document horizontal rule as frontmatter", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "note.md");
    const content = "First paragraph.\n\n---\n\nSecond paragraph after a rule.\n";
    writeFileSync(mdFile, content);

    try {
      const client = new MarkdownTaskTrackerClient({ cwd: testDir });
      const task = await client.getTask("./note.md");

      expect(taskRaw(task).hasFrontmatter).toBe(false);
      expect(task.key).toBe("note");
      expect(client.extractDescriptionText(task)).toBe(content);
    } finally {
      cleanup(testDir);
    }
  });

  test("accepts partial frontmatter without key or status", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "idea.md");
    const content = `---
author: me
tags: backend, perf
---

Refactor the auth middleware.
`;
    writeFileSync(mdFile, content);

    try {
      const client = new MarkdownTaskTrackerClient({ cwd: testDir });
      const task = await client.getTask(mdFile);

      expect(task.key).toBe("idea");
      expect(task.summary).toBe("idea");
      expect(taskRaw(task).hasFrontmatter).toBe(true);
      expect(taskRaw(task).hasStatusField).toBe(false);
      expect(taskRaw(task).frontmatter.author).toBe("me");

      await client.transitionStatus(task.key, "In Progress");
      expect(readFileSync(mdFile, "utf8")).toBe(content);
    } finally {
      cleanup(testDir);
    }
  });

  test("writeAgentPrompt preserves unstructured content and appends instructions", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "spec.md");
    const content = "Ship dark mode toggle in settings.\n";
    writeFileSync(mdFile, content);
    const outputFile = join(testDir, "task-details.md");

    try {
      const client = new MarkdownTaskTrackerClient({ cwd: testDir });
      const task = await client.getTask(mdFile);
      client.writeAgentPrompt(outputFile, task);

      const prompt = readFileSync(outputFile, "utf8");
      expect(prompt.startsWith(content.trim())).toBe(true);
      expect(prompt).toContain("## Implementation Instructions");
    } finally {
      cleanup(testDir);
    }
  });

  test("derives sanitized workflow key from messy filenames", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "My Feature Spec!.md");
    writeFileSync(mdFile, "Just do it.\n");

    try {
      const client = new MarkdownTaskTrackerClient({ cwd: testDir });
      const task = await client.getTask(mdFile);

      expect(task.key).toBe("my-feature-spec");
    } finally {
      cleanup(testDir);
    }
  });

  test("markDoneIfSuccessful is a no-op without a status field", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "todo.md");
    const content = "Fix the flaky test.\n";
    writeFileSync(mdFile, content);
    const taskDir = join(testDir, "output", "todo");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "implementation-summary.md"), "done");

    try {
      const client = new MarkdownTaskTrackerClient({ cwd: testDir });
      const task = await client.getTask(mdFile);
      await client.markDoneIfSuccessful(task.key, taskDir);

      expect(readFileSync(mdFile, "utf8")).toBe(content);
    } finally {
      cleanup(testDir);
    }
  });
});
