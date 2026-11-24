import { describe, expect, test } from "bun:test";

import {
  AUTO_MERGE_COMMENT_MARKER,
  buildAutoMergeStatusComment,
} from "../src/lib/review/auto-merge-comment";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("buildAutoMergeStatusComment", () => {
  test("starts with the marker and names the short commit", () => {
    const body = buildAutoMergeStatusComment({ kind: "merged", method: "squash", headSha: SHA });
    expect(body.startsWith(`${AUTO_MERGE_COMMENT_MARKER}\n`)).toBe(true);
    expect(body).toContain("`0123456`");
    expect(body).toContain("safe paths");
  });

  test("a review-approved merge quotes the agent's reason", () => {
    const body = buildAutoMergeStatusComment({
      kind: "merged",
      method: "merge",
      headSha: SHA,
      agentReason: "only adds tests",
    });
    expect(body).toContain("(merge)");
    expect(body).toContain("judged it safe: only adds tests");
  });

  test("caps the listed files and explains how to get it merged", () => {
    const paths = Array.from({ length: 14 }, (_, i) => `src/file-${i}.ts`);
    const body = buildAutoMergeStatusComment({
      kind: "left-open",
      headSha: SHA,
      reason: { kind: "outside-safe-paths", paths },
    });
    expect(body).toContain("14 changed file(s)");
    expect(body).toContain("- `src/file-9.ts`");
    expect(body).not.toContain("src/file-10.ts");
    expect(body).toContain("…and 4 more");
    expect(body).toContain("`auto_merge_safe_paths`");
  });

  test("neutralizes mentions and backticks from untrusted text", () => {
    const body = buildAutoMergeStatusComment({
      kind: "left-open",
      headSha: SHA,
      reason: { kind: "agent-unsafe", reason: "ping @org/team now", policy: "standard" },
    });
    expect(body).not.toContain("@org");
    // The hold names the policy the review ran under.
    expect(body).toContain("The merge-safety review (`standard` policy) found:");
    const denied = buildAutoMergeStatusComment({
      kind: "left-open",
      headSha: SHA,
      reason: { kind: "denied", path: "a`b.md", pattern: "**/*.md" },
    });
    expect(denied).toContain("`a'b.md`");
  });
});
