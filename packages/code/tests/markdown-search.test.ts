import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MarkdownTaskTrackerClient,
  parseMarkdownTaskQuery,
} from "../src/lib/trackers/markdown/markdown-task-tracker-client";

let tasksDir: string;

beforeEach(() => {
  tasksDir = join(tmpdir(), `md-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tasksDir, { recursive: true });
});

afterEach(() => {
  rmSync(tasksDir, { recursive: true, force: true });
});

function writeTask(filename: string, frontmatter: Record<string, string>, title: string): void {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(join(tasksDir, filename), `---\n${fm}\n---\n\n# ${title}\n\nBody text.\n`, "utf8");
}

describe("parseMarkdownTaskQuery", () => {
  test("parses key=value pairs and free text", () => {
    expect(parseMarkdownTaskQuery('status=todo type="user story" login bug')).toEqual({
      filters: { status: "todo", type: "user story" },
      text: "login bug",
    });
  });

  test("handles pure free text", () => {
    expect(parseMarkdownTaskQuery("just text")).toEqual({
      filters: {},
      text: "just text",
    });
  });
});

describe("MarkdownTaskTrackerClient.searchTasks", () => {
  test("filters by frontmatter fields case-insensitively", async () => {
    writeTask("a.md", { key: "task-a", status: "Todo" }, "Fix login bug");
    writeTask("b.md", { key: "task-b", status: "Done" }, "Write docs");

    const client = new MarkdownTaskTrackerClient({ tasksDirectory: tasksDir });
    const result = await client.searchTasks("status=todo");

    expect(result.total).toBe(1);
    expect(result.tasks[0].key).toBe("task-a");
  });

  test("matches free text against titles", async () => {
    writeTask("a.md", { key: "task-a", status: "Todo" }, "Fix login bug");
    writeTask("b.md", { key: "task-b", status: "Todo" }, "Write docs");

    const client = new MarkdownTaskTrackerClient({ tasksDirectory: tasksDir });
    const result = await client.searchTasks("status=todo login");

    expect(result.tasks.map((t) => t.key)).toEqual(["task-a"]);
  });

  test("returns all markdown tasks for an empty filter set", async () => {
    writeTask("a.md", { key: "task-a", status: "Todo" }, "Fix login bug");
    writeTask("b.md", { key: "task-b", status: "Done" }, "Write docs");

    const client = new MarkdownTaskTrackerClient({ tasksDirectory: tasksDir });
    const result = await client.searchTasks("");

    expect(result.total).toBe(2);
  });

  test("skips files missing the filtered field", async () => {
    writeFileSync(join(tasksDir, "plain.md"), "# No frontmatter here\n", "utf8");
    writeTask("a.md", { key: "task-a", status: "Todo" }, "Fix login bug");

    const client = new MarkdownTaskTrackerClient({ tasksDirectory: tasksDir });
    const result = await client.searchTasks("status=todo");

    expect(result.total).toBe(1);
  });

  test("errors without a tasks directory", async () => {
    const client = new MarkdownTaskTrackerClient({});
    await expect(client.searchTasks("status=todo")).rejects.toThrow("requires MARKDOWN_TASKS_DIR");
  });

  test("errors when the tasks directory does not exist", async () => {
    const client = new MarkdownTaskTrackerClient({
      tasksDirectory: join(tasksDir, "does-not-exist"),
    });
    await expect(client.searchTasks("status=todo")).rejects.toThrow("directory not found");
  });
});
