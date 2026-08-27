import { describe, expect, test } from "bun:test";

import {
  collectDiffContext,
  hasNoBehaviorChanges,
} from "../src/lib/automations/docs-drift-guard/diff-context";
import type { DocsDriftGitPort } from "../src/lib/automations/docs-drift-guard/git-port";

/** Scriptable fake git port: canned outputs keyed by path. */
function fakeGit(options: {
  status: string[];
  numstat?: string[];
  commits?: string[];
  ignored?: string[];
  files?: Record<string, string>;
}): DocsDriftGitPort {
  const files = options.files ?? {};
  return {
    resolveDefaultBranch: async () => "main",
    fetchBranch: async () => true,
    revParse: async () => null,
    isShallow: async () => false,
    isAncestor: async () => true,
    changedFilesWithStatus: async () => options.status,
    numstat: async () => options.numstat ?? [],
    commits: async () => options.commits ?? [],
    ignoredPaths: async () => options.ignored ?? [],
    showFile: async (_cwd, _sha, path, maxBytes) => {
      const content = files[path];
      if (content === undefined) return null;
      return content.length > maxBytes ? content.slice(0, maxBytes) : content;
    },
    isWorkingTreeClean: async () => true,
    workingTreePaths: async () => [],
    currentBranch: async () => "main",
    checkout: async () => {},
    remoteUrl: async () => "https://github.com/acme/api.git",
    checkoutBranchAt: async () => {},
    stagePaths: async () => {},
    commit: async () => "0".repeat(40),
    pushBranch: async () => {},
    repositorySlug: async () => "acme/api",
  };
}

const PATTERNS = ["docs/**", "**/AGENTS.md", "README*"] as const;

describe("docs-drift-guard diff context", () => {
  test("documentation-only ranges have no behavior files", async () => {
    const context = await collectDiffContext(
      fakeGit({ status: ["M\tdocs/guide.md", "M\tREADME.md"] }),
      {
        cwd: "/repo",
        fromSha: "1".repeat(40),
        toSha: "2".repeat(40),
        docPatterns: PATTERNS,
      },
    );
    expect(hasNoBehaviorChanges(context)).toBe(true);
    expect(context.files.map((file) => file.path).sort()).toEqual(["README.md", "docs/guide.md"]);
    expect(context.files.every((file) => file.docRelated)).toBe(true);
  });

  test("behavior files are read at the head revision; docs and ignored files are not", async () => {
    const context = await collectDiffContext(
      fakeGit({
        status: [
          "M\tsrc/app.ts",
          "A\tdocs/new.md",
          "A\t.env.local",
          "D\tsrc/gone.ts",
          "A\tlogo.png",
        ],
        numstat: ["-\t-\tlogo.png"],
        ignored: [".env.local"],
        files: { "src/app.ts": "console.log(1);\n" },
      }),
      { cwd: "/repo", fromSha: "1".repeat(40), toSha: "2".repeat(40), docPatterns: PATTERNS },
    );
    expect(context.behaviorFiles.map((file) => file.path).sort()).toEqual([
      "logo.png",
      "src/app.ts",
      "src/gone.ts",
    ]);
    const app = context.behaviorFiles.find((file) => file.path === "src/app.ts");
    expect(app?.content).toContain("console.log");
    expect(app?.binary).toBe(false);
    expect(context.behaviorFiles.find((file) => file.path === "logo.png")?.binary).toBe(true);
    // Ignored files appear in the full list but never as behavior files.
    expect(context.files.find((file) => file.path === ".env.local")?.ignored).toBe(true);
  });

  test("oversized content and file counts are flagged as truncated", async () => {
    const manyFiles = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`src/file${index}.ts`, "// code\n"]),
    );
    const context = await collectDiffContext(
      fakeGit({
        status: Array.from({ length: 6 }, (_, index) => `M\tsrc/file${index}.ts`),
        files: manyFiles,
      }),
      {
        cwd: "/repo",
        fromSha: "1".repeat(40),
        toSha: "2".repeat(40),
        docPatterns: PATTERNS,
        limits: { maxFiles: 3, maxFileBytes: 5 },
      },
    );
    expect(context.truncated).toBe(true);
    const read = context.behaviorFiles.filter((file) => file.content !== undefined);
    expect(read).toHaveLength(3);
    expect(read.every((file) => file.truncated)).toBe(true); // 5-byte cap
    const overflow = context.behaviorFiles.filter((file) => file.content === undefined);
    expect(overflow.every((file) => file.truncated)).toBe(true);
  });

  test("commits are parsed into evidence records with a cap", async () => {
    const commitRecords = Array.from(
      { length: 4 },
      (_, index) => `sha${index}${"\x1f"}commit ${index}${"\x1f"}Ada`,
    );
    const context = await collectDiffContext(
      fakeGit({ status: ["M\tsrc/a.ts"], commits: commitRecords }),
      {
        cwd: "/repo",
        fromSha: "1".repeat(40),
        toSha: "2".repeat(40),
        docPatterns: PATTERNS,
        limits: { maxCommits: 2 },
      },
    );
    expect(context.commits).toHaveLength(2);
    expect(context.commits[0]).toEqual({ sha: "sha0", subject: "commit 0", author: "Ada" });
    expect(context.truncated).toBe(true);
  });
});
