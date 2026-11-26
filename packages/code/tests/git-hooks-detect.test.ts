import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { Utils } from "../src/lib/utils";

const hasPrePushHook = (cwd: string) => Utils.hasPrePushHook(cwd);

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "git-hooks-detect-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeHook(dir: string, mode: number): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "pre-push");
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, mode);
}

describe("hasPrePushHook", () => {
  test("false without a hook, or with a non-executable one", async () => {
    expect(await hasPrePushHook(repo)).toBe(false);
    writeHook(join(repo, ".git", "hooks"), 0o644);
    expect(await hasPrePushHook(repo)).toBe(false);
  });

  test("true for an executable hook in .git/hooks", async () => {
    writeHook(join(repo, ".git", "hooks"), 0o755);
    expect(await hasPrePushHook(repo)).toBe(true);
  });

  test("follows a relative core.hooksPath", async () => {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: repo });
    writeHook(join(repo, ".githooks"), 0o755);
    expect(await hasPrePushHook(repo)).toBe(true);
  });
});
