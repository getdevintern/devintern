import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  hasStagedChanges,
  hasUncommittedWork,
  stageWorkTreeChanges,
} from "../src/lib/utils/git-stage";

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8" });
}

describe("stageWorkTreeChanges", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "devintern-git-stage-"));
    git(dir, "init -q");
    writeFileSync(join(dir, "kept.txt"), "v1\n");
    writeFileSync(join(dir, "gone.txt"), "bye\n");
    writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
    git(dir, "add .");
    git(dir, "-c user.email=t@t.co -c user.name=T commit -qm init");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function staged(): string[] {
    return git(dir, "diff --cached --name-only").trim().split("\n").filter(Boolean);
  }

  test("stages tracked edits, deletions, and new files", () => {
    writeFileSync(join(dir, "kept.txt"), "v2\n");
    rmSync(join(dir, "gone.txt"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "new module.ts"), "export {};\n");
    writeFileSync(join(dir, "ignored.log"), "noise\n");

    expect(stageWorkTreeChanges(dir)).toEqual({ success: true });
    expect(staged().sort()).toEqual(["gone.txt", "kept.txt", "src/new module.ts"]);
  });

  test("skips sandbox placeholders: special files and empty known mount points", () => {
    execSync("mkfifo .bashrc", { cwd: dir });
    writeFileSync(join(dir, ".profile"), "");
    writeFileSync(join(dir, ".vscode"), "");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), "");
    writeFileSync(join(dir, "new.txt"), "real\n");

    expect(stageWorkTreeChanges(dir)).toEqual({ success: true });
    expect(staged()).toEqual(["new.txt"]);
  });

  test("keeps real content at placeholder paths and other empty files", () => {
    writeFileSync(join(dir, ".mcp.json"), "{}\n");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(dir, "empty.txt"), "");

    expect(stageWorkTreeChanges(dir)).toEqual({ success: true });
    expect(staged().sort()).toEqual([".claude/settings.json", ".mcp.json", "empty.txt"]);
  });

  test("stages untracked files literally, even names that look like pathspec magic", () => {
    writeFileSync(join(dir, ":!src"), "x\n");
    writeFileSync(join(dir, ":(exclude)a"), "x\n");
    writeFileSync(join(dir, "foo[1].ts"), "x\n");
    writeFileSync(join(dir, "foo1.ts"), "x\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "real.ts"), "export {};\n");

    expect(stageWorkTreeChanges(dir)).toEqual({ success: true });
    expect(staged().sort()).toEqual(
      [":!src", ":(exclude)a", "foo1.ts", "foo[1].ts", "src/real.ts"].sort(),
    );
  });

  test("reports a failure when git cannot stage a tracked path", () => {
    rmSync(join(dir, "kept.txt"));
    execSync("mkfifo kept.txt", { cwd: dir });

    const result = stageWorkTreeChanges(dir);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("stages the whole tree when called from a subdirectory", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "keep.txt"), "x\n");
    git(dir, "add sub");
    git(dir, "-c user.email=t@t.co -c user.name=T commit -qm sub");
    writeFileSync(join(dir, "root-new.txt"), "x\n");
    writeFileSync(join(dir, "sub", "new.txt"), "x\n");
    writeFileSync(join(dir, "sub", ".bashrc"), ""); // not a root mount point: real content
    writeFileSync(join(dir, ".bashrc"), ""); // root placeholder: skipped

    expect(stageWorkTreeChanges(join(dir, "sub"))).toEqual({ success: true });
    expect(staged().sort()).toEqual(["root-new.txt", "sub/.bashrc", "sub/new.txt"]);
  });

  test("reports a failure outside a git repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "devintern-not-git-"));
    try {
      expect(stageWorkTreeChanges(outside).success).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("is a no-op on a clean tree", () => {
    expect(stageWorkTreeChanges(dir)).toEqual({ success: true });
    expect(staged()).toEqual([]);
  });
});

describe("hasStagedChanges", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "devintern-git-staged-"));
    git(dir, "init -q");
    writeFileSync(join(dir, "a.txt"), "v1\n");
    git(dir, "add .");
    git(dir, "-c user.email=t@t.co -c user.name=T commit -qm init");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("ignores untracked placeholders and reports staged edits", () => {
    writeFileSync(join(dir, ".bashrc"), "");
    expect(stageWorkTreeChanges(dir)).toEqual({ success: true });
    expect(hasStagedChanges(dir)).toEqual({ success: true, staged: false });

    writeFileSync(join(dir, "a.txt"), "v2\n");
    expect(stageWorkTreeChanges(dir)).toEqual({ success: true });
    expect(hasStagedChanges(dir)).toEqual({ success: true, staged: true });
  });

  test("reports a failure outside a git repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "devintern-not-git-"));
    try {
      const result = hasStagedChanges(outside);
      expect(result.success).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("hasUncommittedWork", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "devintern-git-work-"));
    git(dir, "init -q");
    writeFileSync(join(dir, "a.txt"), "v1\n");
    git(dir, "add .");
    git(dir, "-c user.email=t@t.co -c user.name=T commit -qm init");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("ignores untracked sandbox placeholders", () => {
    execSync("mkfifo .gitconfig", { cwd: dir });
    writeFileSync(join(dir, ".bashrc"), "");
    expect(hasUncommittedWork(dir)).toEqual({ success: true, dirty: false });
  });

  test("counts tracked edits, staged edits, and real new files, from any subdirectory", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "new.txt"), "x\n");
    expect(hasUncommittedWork(join(dir, "sub"))).toEqual({ success: true, dirty: true });
    rmSync(join(dir, "new.txt"));

    writeFileSync(join(dir, "a.txt"), "v2\n");
    expect(hasUncommittedWork(dir)).toEqual({ success: true, dirty: true });
    git(dir, "add a.txt");
    expect(hasUncommittedWork(dir)).toEqual({ success: true, dirty: true });
  });

  test("reports a failure outside a git repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "devintern-not-git-"));
    try {
      expect(hasUncommittedWork(outside).success).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
