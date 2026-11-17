import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateFixPrompt,
  getPRDiff,
  parseReviewFeedback,
} from "../src/lib/review/auto-review-loop";
import { validateReviewFeedback } from "../src/lib/review/feedback";
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
  test("returns a contradictory approval when the caller owns the policy", () => {
    const json = JSON.stringify({ ...verdict, approved: true });
    // Steps like `verify` resolve the contradiction themselves, so they need
    // the verdict rather than a parse error that would burn a retry.
    expect(parseReviewFeedback(json, { enforceApproval: false })).toEqual({
      ...verdict,
      approved: true,
    });
    // Skipping the approval check must not skip schema validation.
    expect(() =>
      parseReviewFeedback(
        JSON.stringify({ ...verdict, items: [{ ...finding, priority: "urgent" }] }),
        {
          enforceApproval: false,
        },
      ),
    ).toThrow("Invalid feedback structure");
  });
  test("accepts valid findings and a clean approval", () => {
    expect(parseReviewFeedback(JSON.stringify(verdict))).toEqual(verdict);
    expect(
      parseReviewFeedback(JSON.stringify({ ...verdict, approved: true, items: [] })).approved,
    ).toBe(true);
  });
  test("keeps evidence/confidence and rejects an unknown confidence", () => {
    const proven = { ...finding, confidence: "low" as const, evidence: "unproven" };
    expect(parseReviewFeedback(JSON.stringify({ ...verdict, items: [proven] }))).toEqual({
      ...verdict,
      items: [proven],
    });
    expect(() =>
      parseReviewFeedback(
        JSON.stringify({ ...verdict, items: [{ ...finding, confidence: "certain" }] }),
      ),
    ).toThrow();
  });

  test("downgrades an unproven confidence instead of rejecting the payload", () => {
    const parse = (item: ReviewFeedbackItem) =>
      parseReviewFeedback(JSON.stringify({ ...verdict, items: [item] }));

    // Above-low confidence without concrete evidence is coerced to low, so the
    // finding is still reported rather than dropped.
    expect(parse({ ...finding, confidence: "high" })).toEqual({
      ...verdict,
      items: [{ ...finding, confidence: "low" }],
    });
    expect(parse({ ...finding, confidence: "medium" })).toEqual({
      ...verdict,
      items: [{ ...finding, confidence: "low" }],
    });
    expect(parse({ ...finding, confidence: "high", evidence: "unproven" })).toEqual({
      ...verdict,
      items: [{ ...finding, confidence: "low", evidence: "unproven" }],
    });
    expect(parse({ ...finding, confidence: "medium", evidence: "" })).toEqual({
      ...verdict,
      items: [{ ...finding, confidence: "low", evidence: "" }],
    });
    expect(parse({ ...finding, confidence: "high", evidence: "asserted" })).toEqual({
      ...verdict,
      items: [{ ...finding, confidence: "low", evidence: "asserted" }],
    });
    expect(parse({ ...finding, confidence: "medium", evidence: "N/A" })).toEqual({
      ...verdict,
      items: [{ ...finding, confidence: "low", evidence: "N/A" }],
    });
    expect(parse({ ...finding, confidence: "high", evidence: "none" })).toEqual({
      ...verdict,
      items: [{ ...finding, confidence: "low", evidence: "none" }],
    });

    const ranIt = { ...finding, confidence: "high" as const, evidence: "bun test -> 12 pass" };
    expect(parse(ranIt)).toEqual({ ...verdict, items: [ranIt] });
  });

  test("propagates evidence/confidence into the fix prompt", () => {
    const item: ReviewFeedbackItem = {
      ...finding,
      confidence: "low",
      evidence: "unproven",
    };
    const prompt = generateFixPrompt([item], 1);

    expect(prompt).toContain("Confidence: low");
    expect(prompt).toContain("Evidence: unproven");
  });
});

describe("approval threshold", () => {
  const medium: ReviewFeedbackItem = {
    priority: "medium",
    category: "bug",
    issue: "Advisory finding",
    suggestion: "Consider fixing",
  };
  const approvedWithMedium = { summary: "Meets the requirements", approved: true, items: [medium] };

  test("rejects an approval with findings at the default medium threshold", () => {
    expect(() => validateReviewFeedback({ ...approvedWithMedium, items: [{ ...medium }] })).toThrow(
      "medium-or-higher",
    );
  });

  test("accepts an approval whose findings sit below the caller's threshold", () => {
    // Verification defaults to `high`, where medium findings are advisory.
    expect(() =>
      validateReviewFeedback({ ...approvedWithMedium, items: [{ ...medium }] }, "high"),
    ).not.toThrow();
  });

  test("rejects an approval with findings at or above the caller's threshold", () => {
    expect(() =>
      validateReviewFeedback(
        { ...approvedWithMedium, items: [{ ...medium, priority: "high" }] },
        "high",
      ),
    ).toThrow("high-or-higher");
  });
});
