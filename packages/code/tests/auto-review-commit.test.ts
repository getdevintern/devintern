import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { amendCommit, commitChanges } from "../src/lib/review/auto-review-loop";

function git(cwd: string, cmd: string): string {
  return execSync(`git -c user.email=t@t.co -c user.name=T ${cmd}`, { cwd, encoding: "utf8" });
}

describe("auto-review commit/amend with only sandbox placeholders", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "devintern-auto-review-commit-"));
    git(dir, "init -q");
    git(dir, "config user.email t@t.co");
    git(dir, "config user.name T");
    writeFileSync(join(dir, "a.txt"), "v1\n");
    git(dir, "add .");
    git(dir, "commit -qm init");
    // Leftover empty mount point from the agent sandbox.
    writeFileSync(join(dir, ".bashrc"), "");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const head = () => git(dir, "rev-parse HEAD").trim();

  test("commitChanges creates no commit and does not throw", () => {
    const before = head();
    expect(() => commitChanges("fix: address PR review feedback", dir)).not.toThrow();
    expect(head()).toBe(before);
  });

  test("amendCommit leaves the previous commit untouched", () => {
    const before = head();
    expect(() => amendCommit("Iteration 2: address additional review feedback", dir)).not.toThrow();
    expect(head()).toBe(before);
    expect(git(dir, "log -1 --format=%B").trim()).toBe("init");
  });

  test("real changes next to the placeholder are still committed and amended", () => {
    writeFileSync(join(dir, "a.txt"), "v2\n");
    commitChanges("fix: address PR review feedback", dir);
    expect(git(dir, "show --name-only --format= HEAD").trim()).toBe("a.txt");

    writeFileSync(join(dir, "a.txt"), "v3\n");
    amendCommit("Iteration 2: more", dir);
    expect(git(dir, "log -1 --format=%B").trim()).toBe(
      "fix: address PR review feedback\n\nIteration 2: more",
    );
    expect(git(dir, "ls-files").trim()).toBe("a.txt");
  });
});
