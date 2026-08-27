import { describe, expect, test } from "bun:test";

import {
  DOCS_DRIFT_DEFAULT_DOC_PATTERNS,
  docPathPatternToRegExp,
  isDocumentationPath,
  resolveDocPatterns,
  validateDocPathOverrides,
} from "../src/lib/automations/docs-drift-guard/paths";

describe("docs-drift-guard path selection", () => {
  test("default patterns cover docs/, nested instruction files, and READMEs", () => {
    const matches = [
      "docs/guide/setup.md",
      "AGENTS.md",
      "packages/api/AGENTS.md",
      "CLAUDE.md",
      "deeply/nested/CLAUDE.md",
      "README.md",
      "README",
      "READMENOW.md",
    ];
    for (const path of matches) {
      expect(isDocumentationPath(path, DOCS_DRIFT_DEFAULT_DOC_PATTERNS), path).toBe(true);
    }
    for (const path of [
      "src/index.ts",
      "docs/notes.txt",
      "docs.md",
      "agents.md",
      "lib/README.txt",
    ]) {
      expect(isDocumentationPath(path, DOCS_DRIFT_DEFAULT_DOC_PATTERNS), path).toBe(false);
    }
  });

  test("overrides replace the default set", () => {
    const patterns = ["guides/**/*.md", "handbook.md"];
    expect(isDocumentationPath("guides/a/b/c.md", patterns)).toBe(true);
    expect(isDocumentationPath("handbook.md", patterns)).toBe(true);
    expect(isDocumentationPath("docs/guide.md", patterns)).toBe(false);
  });

  test("`docs/**` also matches files directly under docs/", () => {
    expect(isDocumentationPath("docs/a.md", ["docs/**"])).toBe(true);
    expect(isDocumentationPath("docs/x/a.md", ["docs/**"])).toBe(true);
  });

  test("glob compiler handles single stars and question marks", () => {
    expect(docPathPatternToRegExp("a/*/b.md").test("a/x/b.md")).toBe(true);
    expect(docPathPatternToRegExp("a/*/b.md").test("a/x/y/b.md")).toBe(false);
    expect(docPathPatternToRegExp("a?c.md").test("abc.md")).toBe(true);
    expect(docPathPatternToRegExp("a?c.md").test("a/c.md")).toBe(false);
  });

  describe("validateDocPathOverrides", () => {
    const errors: string[] = [];
    const collect = (value: unknown) => validateDocPathOverrides(value, (m) => errors.push(m));

    test("undefined passes through", () => {
      expect(collect(undefined)).toBeUndefined();
      expect(errors).toHaveLength(0);
    });

    test("non-arrays are rejected", () => {
      expect(collect("docs/**")).toBeUndefined();
      expect(errors[0]).toContain("must be an array");
    });

    test("valid globs are returned", () => {
      expect(collect(["docs/**", "guide-[1]/*.md"])).toEqual(["docs/**", "guide-[1]/*.md"]);
    });

    test("rejects absolute paths, traversal, and backslashes", () => {
      collect(["/etc/passwd", "../up.md", "windows\\path.md", "  "]);
      expect(errors.join("\n")).toContain('no leading "/"');
      expect(errors.join("\n")).toContain('"..")');
      expect(errors.join("\n")).toContain("forward slashes");
      expect(errors.join("\n")).toContain("non-empty strings");
    });
  });

  test("resolveDocPatterns falls back to defaults when no override", () => {
    expect(resolveDocPatterns({})).toBe(DOCS_DRIFT_DEFAULT_DOC_PATTERNS);
    expect(resolveDocPatterns({ docPaths: ["custom.md"] })).toEqual(["custom.md"]);
  });
});
