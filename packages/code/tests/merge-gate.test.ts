import { describe, expect, test } from "bun:test";

import {
  classifyChangedPaths,
  normalizeGlob,
  parseMergeSafetyVerdict,
} from "../src/lib/review/merge-gate";

const policy = { safePaths: ["**/*.md", "packages/*/tests/e2e/**"], denyPaths: [] };

describe("classifyChangedPaths", () => {
  test("only safe paths → safe", () => {
    expect(
      classifyChangedPaths(
        [
          { path: "README.md" },
          { path: "docs/guide/setup.md" },
          { path: "packages/code/tests/e2e/a.ts" },
        ],
        policy,
      ),
    ).toEqual({ kind: "safe" });
  });

  test("any path outside the safe globs → needs-review, listing them once", () => {
    expect(
      classifyChangedPaths(
        [{ path: "README.md" }, { path: "src/index.ts" }, { path: "src/index.ts" }],
        policy,
      ),
    ).toEqual({ kind: "needs-review", outside: ["src/index.ts"] });
  });

  test("deny globs win over safe globs", () => {
    expect(
      classifyChangedPaths([{ path: "docs/secret.md" }], {
        safePaths: ["docs/**"],
        denyPaths: ["docs/secret.md"],
      }),
    ).toEqual({ kind: "denied", path: "docs/secret.md", pattern: "docs/secret.md" });
  });

  test("built-in deny list applies even when the path is listed as safe", () => {
    const result = classifyChangedPaths([{ path: ".github/workflows/ci.yml" }], {
      safePaths: ["**"],
      denyPaths: [],
    });
    expect(result.kind).toBe("denied");
    expect(
      classifyChangedPaths([{ path: "CODEOWNERS" }], { safePaths: ["**"], denyPaths: [] }).kind,
    ).toBe("denied");
    expect(
      classifyChangedPaths([{ path: ".devintern-code/prompts/review.md" }], {
        safePaths: ["**"],
        denyPaths: [],
      }).kind,
    ).toBe("denied");
  });

  test("a rename is judged on both its old and new path", () => {
    // Moving a source file into docs/ must not look docs-only.
    expect(
      classifyChangedPaths([{ path: "docs/notes.md", previousPath: "src/auth.ts" }], policy),
    ).toEqual({ kind: "needs-review", outside: ["src/auth.ts"] });
    // Moving a workflow out of .github/ still hits the deny list.
    expect(
      classifyChangedPaths(
        [{ path: "docs/ci.md", previousPath: ".github/workflows/ci.yml" }],
        policy,
      ).kind,
    ).toBe("denied");
  });

  test("fails closed on empty or non-normalized file lists", () => {
    expect(classifyChangedPaths([], policy).kind).toBe("invalid");
    expect(classifyChangedPaths([{ path: "docs/../src/a.md" }], policy).kind).toBe("invalid");
    expect(classifyChangedPaths([{ path: "/etc/passwd.md" }], policy).kind).toBe("invalid");
  });

  test("no safe paths sends everything to review", () => {
    expect(classifyChangedPaths([{ path: "README.md" }], { safePaths: [], denyPaths: [] })).toEqual(
      { kind: "needs-review", outside: ["README.md"] },
    );
  });

  test("trailing-slash globs mean everything below", () => {
    expect(normalizeGlob("docs/")).toBe("docs/**");
    expect(normalizeGlob("./e2e/**")).toBe("e2e/**");
    expect(
      classifyChangedPaths([{ path: "e2e/specs/login.spec.ts" }], {
        safePaths: ["e2e/"],
        denyPaths: [],
      }),
    ).toEqual({ kind: "safe" });
  });
});

describe("parseMergeSafetyVerdict", () => {
  test("reads the verdict from the final stdout line", () => {
    const output = [
      'Example format: {"safe": true, "reason": "example"}',
      "Analysis…",
      '{"safe": false, "reason": "changes the auth middleware"}',
    ].join("\n");
    expect(parseMergeSafetyVerdict(output)).toEqual({
      safe: false,
      reason: "changes the auth middleware",
    });
  });

  test("prose as the final line is no verdict, even after an earlier approving JSON", () => {
    const output = [
      '{"safe": true, "reason": "tests only"}',
      "This PR changes auth middleware; I would not merge it unattended.",
    ].join("\n");
    expect(parseMergeSafetyVerdict(output)).toBeNull();
  });

  test("ignores trailing whitespace and ANSI reset codes after the verdict", () => {
    const output =
      'Looks fine.\n\x1b[32m{"safe": true, "reason": "docs only"}\x1b[0m\n\x1b[0m  \n\n';
    expect(parseMergeSafetyVerdict(output)).toEqual({ safe: true, reason: "docs only" });
    expect(parseMergeSafetyVerdict('{"safe": true, "reason": "x"}\r\n')).toEqual({
      safe: true,
      reason: "x",
    });
  });

  test("rejects verdicts without a boolean safe flag", () => {
    expect(parseMergeSafetyVerdict('{"safe": "yes", "reason": "x"}')).toBeNull();
    expect(parseMergeSafetyVerdict('{"safe": "true", "reason": "x"}')).toBeNull();
    expect(parseMergeSafetyVerdict("looks safe to me")).toBeNull();
    expect(parseMergeSafetyVerdict("")).toBeNull();
    expect(parseMergeSafetyVerdict("[true]")).toBeNull();
  });

  test("rejects malformed JSON or a verdict embedded in prose on the last line", () => {
    expect(parseMergeSafetyVerdict('{"safe": true, "reason": "x"')).toBeNull();
    expect(parseMergeSafetyVerdict('{"safe": true, reason: "x"}')).toBeNull();
    expect(parseMergeSafetyVerdict('Verdict: {"safe": true, "reason": "x"}')).toBeNull();
    expect(parseMergeSafetyVerdict('{"safe": true, "reason": "x"} — done')).toBeNull();
  });

  test("fills a missing reason", () => {
    expect(parseMergeSafetyVerdict('{"safe": true}')).toEqual({
      safe: true,
      reason: "(no reason given)",
    });
  });
});
