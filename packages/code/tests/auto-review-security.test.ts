import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPRDiff, parseReviewFeedback } from "../src/lib/review/auto-review-loop";
import type { ReviewFeedbackItem } from "../src/types/auto-review";

describe("review diff command safety", () => {
  let dir: string;
  function git(...args: string[]) {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "review-security-"));
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", "/dev/null");
    writeFileSync(join(dir, "file.txt"), "before\n");
    git("add", ".");
    git("commit", "-m", "base");
    git("remote", "add", "origin", ".");
    git("checkout", "-b", "topic");
    writeFileSync(join(dir, "file.txt"), "after\n");
    git("commit", "-am", "change");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("treats shell metacharacters in a valid branch name as literal data", () => {
    const branch = "base;touch${IFS}injection-ran;#";
    git("branch", branch, "main");
    const diff = getPRDiff(branch, dir);
    expect(existsSync(join(dir, "injection-ran"))).toBe(false);
    expect(diff).toContain("-before\n+after");
  });

  test("supports origin-prefixed branch names", () => {
    expect(getPRDiff("origin/main", dir)).toContain("-before\n+after");
  });

  test("rejects revision expressions instead of reviewing a different ref", () => {
    expect(() => getPRDiff("main~1", dir)).toThrow("Invalid PR base branch name");
  });

  test.each(["external", "textconv"])("does not execute a configured %s diff helper", (kind) => {
    writeFileSync(join(dir, "driver.sh"), "touch diff-helper-ran\nprintf 'fake diff'\n");
    if (kind === "external") {
      git("config", "diff.external", "sh driver.sh");
    } else {
      writeFileSync(join(dir, ".gitattributes"), "file.txt diff=custom\n");
      git("config", "diff.custom.textconv", "sh driver.sh");
    }
    expect(getPRDiff("main", dir)).toContain("-before\n+after");
    expect(existsSync(join(dir, "diff-helper-ran"))).toBe(false);
  });
});

describe("review feedback validation", () => {
  const finding: ReviewFeedbackItem = {
    priority: "high",
    category: "security",
    issue: "Unsafe execution",
    suggestion: "Fix it",
  };
  const verdict = { summary: "Fix required", approved: false, items: [finding] };

  test.each(["CRITICAL", "__proto__", "unknown", null])(
    "rejects invalid priority %s",
    (priority) => {
      expect(() =>
        parseReviewFeedback(JSON.stringify({ ...verdict, items: [{ ...finding, priority }] })),
      ).toThrow();
    },
  );
  test.each([null, {}, { ...finding, issue: {} }, { ...finding, file: 42 }])(
    "rejects malformed findings",
    (item) => {
      expect(() => parseReviewFeedback(JSON.stringify({ ...verdict, items: [item] }))).toThrow();
    },
  );
  test("rejects an approval contradicting a blocking finding", () => {
    expect(() => parseReviewFeedback(JSON.stringify({ ...verdict, approved: true }))).toThrow(
      "cannot approve",
    );
  });
  test("accepts valid findings and a clean approval", () => {
    expect(parseReviewFeedback(JSON.stringify(verdict))).toEqual(verdict);
    expect(
      parseReviewFeedback(JSON.stringify({ ...verdict, approved: true, items: [] })).approved,
    ).toBe(true);
  });
});
