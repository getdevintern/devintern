import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(__dirname, "..", "src", "index.ts");

interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCLI(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  timeoutMs = 15000,
): CLIResult {
  const result = spawnSync("bun", [CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    cwd,
    env: {
      ...process.env,
      DEVINTERN_SKIP_LICENSE_CHECK: "1",
      ...env,
    },
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 0,
  };
}

function makeTestDir(): string {
  const dir = join(tmpdir(), `md-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
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

// Fast-exit tests use /usr/bin/true as the agent so they don't wait for a real LLM.
// /usr/bin/true exits 0 immediately; the workflow sees an "incomplete" implementation
// (empty output) but the file-detection and setup phases still execute.
const FAKE_AGENT = "/usr/bin/true";

describe("Markdown file path detection", () => {
  test("accepts an absolute .md file path as task argument", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    writeFileSync(mdFile, "# My Task\n\nDo the thing.\n");
    try {
      const result = runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      const output = result.stdout + result.stderr;
      expect(output).not.toContain("Missing required JIRA environment variables");
      expect(output).not.toContain("Unsupported task tracker");
      expect(output).toContain("Processing markdown file");
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("accepts a relative path like ./task.md", () => {
    const testDir = makeTestDir();
    writeFileSync(join(testDir, "task.md"), "# Test\n\nContent.\n");
    try {
      const result = runCLI(
        ["./task.md", "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      const output = result.stdout + result.stderr;
      expect(output).not.toContain("Missing required JIRA environment variables");
      expect(output).toContain("Processing markdown file");
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("shows error when .md file does not exist", () => {
    const testDir = makeTestDir();
    try {
      const result = runCLI(
        ["/nonexistent/path/task.md", "--no-git", "--skip-clarity-check"],
        testDir,
      );
      const output = result.stdout + result.stderr;
      expect(output).toContain("File not found");
      expect(result.exitCode).not.toBe(0);
    } finally {
      cleanup(testDir);
    }
  }, 10000);

  test("shows error for empty .md file", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "empty.md");
    writeFileSync(mdFile, "   \n  ");
    try {
      const result = runCLI([mdFile, "--no-git", "--skip-clarity-check"], testDir);
      const output = result.stdout + result.stderr;
      expect(output).toContain("empty");
      expect(result.exitCode).not.toBe(0);
    } finally {
      cleanup(testDir);
    }
  }, 10000);

  test("does not require PM credentials for .md file task", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "spec.md");
    writeFileSync(mdFile, "# Feature Spec\n\nImplement the feature.\n");
    try {
      const result = runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
        {
          JIRA_BASE_URL: "",
          JIRA_EMAIL: "",
          JIRA_API_TOKEN: "",
        },
      );
      const output = result.stdout + result.stderr;
      expect(output).not.toContain("Missing required JIRA environment variables");
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("extracts title from H1 heading", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    writeFileSync(mdFile, "# My Awesome Feature\n\nDescription here.\n");
    try {
      const result = runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      expect(result.stdout).toContain("My Awesome Feature");
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("falls back to filename when no H1 heading", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "my-feature.md");
    writeFileSync(mdFile, "Just some description without a heading.\n");
    try {
      const result = runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      const output = result.stdout + result.stderr;
      expect(output).toContain("Processing markdown file");
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("uses frontmatter key as task key", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "some-file.md");
    writeFileSync(
      mdFile,
      `---
key: my-custom-key
type: Story
created_at: 2025-01-01T00:00:00Z
---

# My Task

Description.
`,
    );
    try {
      const result = runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      expect(result.stdout).toContain("Key: my-custom-key");
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("saves task-details.md to output directory", () => {
    const testDir = makeTestDir();
    const outputDir = join(testDir, "output");
    const mdFile = join(testDir, "task.md");
    writeFileSync(mdFile, "# My Task\n\nDo the thing.\n");
    try {
      runCLI([mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT], testDir, {
        DEVINTERN_OUTPUT_DIR: outputDir,
      });
      expect(existsSync(outputDir)).toBe(true);
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("appends implementation instructions when not present", () => {
    const testDir = makeTestDir();
    const outputDir = join(testDir, "output");
    const mdFile = join(testDir, "my-task.md");
    writeFileSync(mdFile, "# My Task\n\nDo the thing.\n");
    try {
      runCLI([mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT], testDir, {
        DEVINTERN_OUTPUT_DIR: outputDir,
      });
      const taskDetailsDir = join(outputDir, "my-task");
      if (existsSync(taskDetailsDir)) {
        const taskDetails = readFileSync(join(taskDetailsDir, "task-details.md"), "utf8");
        expect(taskDetails).toContain("## Implementation Instructions");
      }
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("does not duplicate implementation instructions when already present", () => {
    const testDir = makeTestDir();
    const outputDir = join(testDir, "output");
    const mdFile = join(testDir, "my-task.md");
    writeFileSync(
      mdFile,
      "# My Task\n\nDo the thing.\n\n## Implementation Instructions\n\nAlready here.\n",
    );
    try {
      runCLI([mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT], testDir, {
        DEVINTERN_OUTPUT_DIR: outputDir,
      });
      const taskDetailsDir = join(outputDir, "my-task");
      if (existsSync(taskDetailsDir)) {
        const taskDetails = readFileSync(join(taskDetailsDir, "task-details.md"), "utf8");
        const count = (taskDetails.match(/## Implementation Instructions/g) || []).length;
        expect(count).toBe(1);
      }
    } finally {
      cleanup(testDir);
    }
  }, 30000);
});

describe("Markdown frontmatter status transitions", () => {
  test("updates status away from 'To Do' when frontmatter has status field", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    writeFileSync(
      mdFile,
      `---
key: test-task
status: To Do
---

# Test Task

Description.
`,
    );
    try {
      runCLI([mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT], testDir);
      const updated = readFileSync(mdFile, "utf8");
      // Status must have transitioned away from "To Do" (to "In Progress" or "Done")
      expect(updated).not.toContain("status: To Do");
      expect(updated).toContain("status:");
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("transitions to In Progress before agent runs", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    writeFileSync(
      mdFile,
      `---
key: test-task
status: To Do
---

# Test Task

Description.
`,
    );
    try {
      const result = runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      expect(result.stdout).toContain("In Progress");
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("does not modify file when frontmatter has no status field", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    const originalContent = `---
key: test-task
type: Story
---

# Test Task

Description.
`;
    writeFileSync(mdFile, originalContent);
    try {
      runCLI([mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT], testDir);
      const after = readFileSync(mdFile, "utf8");
      expect(after).not.toContain("status:");
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("does not modify file when there is no frontmatter", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    const originalContent = "# Task\n\nNo frontmatter here.\n";
    writeFileSync(mdFile, originalContent);
    try {
      runCLI([mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT], testDir);
      const after = readFileSync(mdFile, "utf8");
      expect(after).toBe(originalContent);
    } finally {
      cleanup(testDir);
    }
  }, 30000);
});

describe("Unstructured markdown files", () => {
  test("processes plain prose with no heading, key, or frontmatter", () => {
    const testDir = makeTestDir();
    const outputDir = join(testDir, "output");
    const mdFile = join(testDir, "backlog-item.md");
    const originalContent =
      "Implement caching for the user profile endpoint.\n\nAcceptance: p95 under 200ms.\n";
    writeFileSync(mdFile, originalContent);

    try {
      const result = runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
        { DEVINTERN_OUTPUT_DIR: outputDir },
      );
      const output = result.stdout + result.stderr;

      expect(result.exitCode).toBe(0);
      expect(output).toContain("Processing markdown file");
      expect(output).toContain("Key: backlog-item");
      expect(output).toContain("Summary: backlog-item");
      expect(output).toContain("Status: Unknown");
      expect(output).not.toContain("Updating status");

      expect(readFileSync(mdFile, "utf8")).toBe(originalContent);

      const taskDetails = readFileSync(join(outputDir, "backlog-item", "task-details.md"), "utf8");
      expect(taskDetails).toContain("Implement caching for the user profile endpoint.");
      expect(taskDetails).toContain("## Implementation Instructions");
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("processes markdown with H2 sections but no H1", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "refactor-auth.md");
    const originalContent = `## Context

Auth middleware is duplicated across services.

## Goal

Extract shared middleware package.
`;
    writeFileSync(mdFile, originalContent);

    try {
      const result = runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );

      expect(result.stdout).toContain("Key: refactor-auth");
      expect(result.stdout).toContain("Summary: refactor-auth");
      expect(readFileSync(mdFile, "utf8")).toBe(originalContent);
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("processes non-devpm frontmatter without key or status", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "obsidian-note.md");
    const originalContent = `---
author: me
source: obsidian
---

Random note: wire up webhook retries with exponential backoff.
`;
    writeFileSync(mdFile, originalContent);

    try {
      const result = runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      const output = result.stdout + result.stderr;

      expect(output).toContain("Key: obsidian-note");
      expect(output).toContain("Status: Unknown");
      expect(output).not.toContain("Updating status");
      expect(readFileSync(mdFile, "utf8")).toBe(originalContent);
    } finally {
      cleanup(testDir);
    }
  }, 30000);

  test("processes batch of unstructured markdown files", () => {
    const testDir = makeTestDir();
    writeFileSync(join(testDir, "one.md"), "First task.\n");
    writeFileSync(join(testDir, "two.md"), "Second task.\n");

    try {
      const result = runCLI(
        ["./one.md", "./two.md", "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
        {
          JIRA_BASE_URL: "",
          JIRA_EMAIL: "",
          JIRA_API_TOKEN: "",
        },
      );
      const output = result.stdout + result.stderr;

      expect(result.exitCode).toBe(0);
      expect(output).toContain("Processing 2 task(s)");
      expect(output).toContain("Key: one");
      expect(output).toContain("Key: two");
    } finally {
      cleanup(testDir);
    }
  }, 30000);
});

describe("PM frontmatter key lookup", () => {
  test("resolves short frontmatter key to slugged PM filename", () => {
    const testDir = makeTestDir();
    const tasksDir = join(testDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const mdFile = join(tasksDir, "2026-06-06T09-42-23-kfg5-enable-agent-harness.md");
    writeFileSync(
      mdFile,
      `---
key: 2026-06-06T09-42-23-kfg5
type: Task
created_at: 2026-06-06T09:42:23.735Z
---

# Enable agent harness selection

Description.
`,
    );

    try {
      const result = runCLI(
        [
          "2026-06-06T09-42-23-kfg5",
          "--no-git",
          "--skip-clarity-check",
          "--agent-path",
          FAKE_AGENT,
        ],
        testDir,
        {
          TASK_TRACKER: "markdown",
          MARKDOWN_TASKS_DIR: tasksDir,
        },
      );
      const output = result.stdout + result.stderr;

      expect(output).not.toContain("File not found");
      expect(output).toContain("Key: 2026-06-06t09-42-23-kfg5");
      expect(output).toContain("Enable agent harness selection");
    } finally {
      cleanup(testDir);
    }
  }, 30000);
});

describe("Mixed PM task keys and file paths", () => {
  test("requires PM credentials when mixing PM keys with file paths", () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    writeFileSync(mdFile, "# Task\n\nDescription.\n");
    try {
      const result = runCLI(["PROJ-123", mdFile, "--no-git", "--skip-clarity-check"], testDir, {
        JIRA_BASE_URL: "",
        JIRA_EMAIL: "",
        JIRA_API_TOKEN: "",
      });
      const output = result.stdout + result.stderr;
      expect(output).toContain("Missing required JIRA environment variables");
    } finally {
      cleanup(testDir);
    }
  }, 10000);
});
