import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  extractMarkdownTitle,
  parseMarkdownFrontmatter,
  sanitizeMarkdownTaskKey,
  updateMarkdownFrontmatterField,
} from "./src/markdown/frontmatter.ts";
import {
  findMarkdownTaskFileByKey,
  isMarkdownFilePath,
  resolveMarkdownTaskPath,
} from "./src/markdown/path-utils.ts";

describe("parseMarkdownFrontmatter", () => {
  test("parses simple frontmatter", () => {
    const content = `---
key: abc
status: To Do
---

# Title

Body.
`;
    const parsed = parseMarkdownFrontmatter(content);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter.key).toBe("abc");
    expect(parsed.frontmatter.status).toBe("To Do");
    expect(parsed.body).toContain("# Title");
  });

  test("returns original body when frontmatter is missing", () => {
    const content = "# Title\n\nBody.";
    const parsed = parseMarkdownFrontmatter(content);
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe(content);
  });

  test("does not treat an opening --- without a closing delimiter as frontmatter", () => {
    const content = "---\nauthor: me\n\nBody continues without closing fence.\n";
    const parsed = parseMarkdownFrontmatter(content);
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe(content);
  });
});

describe("updateMarkdownFrontmatterField", () => {
  test("updates an existing status field", () => {
    const content = `---
key: abc
status: To Do
---

# Title
`;
    const updated = updateMarkdownFrontmatterField(content, "status", "Done");
    expect(updated).toContain("status: Done");
    expect(updated).not.toContain("status: To Do");
  });

  test("returns null when frontmatter is absent", () => {
    expect(updateMarkdownFrontmatterField("# Title", "status", "Done")).toBeNull();
  });
});

describe("extractMarkdownTitle", () => {
  test("extracts first H1", () => {
    expect(extractMarkdownTitle("# Hello World\n\nText.")).toBe("Hello World");
  });
});

describe("sanitizeMarkdownTaskKey", () => {
  test("normalizes keys", () => {
    expect(sanitizeMarkdownTaskKey("My Custom Key!")).toBe("my-custom-key");
  });
});

describe("isMarkdownFilePath", () => {
  test("detects common path shapes", () => {
    expect(isMarkdownFilePath("./task.md")).toBe(true);
    expect(isMarkdownFilePath("/tmp/task.md")).toBe(true);
    expect(isMarkdownFilePath("PROJ-123")).toBe(false);
  });
});

describe("resolveMarkdownTaskPath", () => {
  test("resolves keys against a tasks directory", () => {
    expect(resolveMarkdownTaskPath("my-task", "/tasks", "/repo")).toBe("/tasks/my-task.md");
  });

  test("scans frontmatter key when direct filename is missing", () => {
    const testDir = join(tmpdir(), `md-scan-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "2026-06-06T09-42-23-kfg5-enable-agent-harness.md");
    writeFileSync(
      filePath,
      `---
key: 2026-06-06T09-42-23-kfg5
type: Task
---

# Enable agent harness selection
`,
    );

    try {
      expect(resolveMarkdownTaskPath("2026-06-06T09-42-23-kfg5", testDir)).toBe(filePath);
      expect(findMarkdownTaskFileByKey("2026-06-06T09-42-23-kfg5", testDir)).toBe(filePath);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("falls back to filename stem prefix when frontmatter key is absent", () => {
    const testDir = join(tmpdir(), `md-prefix-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "my-key-some-feature-slug.md");
    writeFileSync(filePath, "# Feature\n\nBody.\n");

    try {
      expect(resolveMarkdownTaskPath("my-key", testDir)).toBe(filePath);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
