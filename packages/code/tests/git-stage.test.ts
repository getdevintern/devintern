import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { stageWorkTreeChanges } from "../src/lib/utils/git-stage";

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

  test("is a no-op on a clean tree", () => {
    expect(stageWorkTreeChanges(dir)).toEqual({ success: true });
    expect(staged()).toEqual([]);
  });
});
