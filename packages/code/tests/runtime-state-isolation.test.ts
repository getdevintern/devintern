/**
 * Regression coverage for DEV-126: worker task runs must resolve durable
 * state to the workspace home, and a repo checkout must never have
 * `.devintern-code/` runtime artifacts staged into a PR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { LockManager } from "../src/lib/lock-manager";
import {
  CONFIG_DIR_ENV,
  configDirOverride,
  resolveProjectConfigDir,
} from "../src/lib/config/config-dir";
import { loadSupabaseConfig } from "../src/lib/cli/bootstrap";
import { ensureGitInfoExcluded } from "../src/lib/utils/git-exclude";
import { pinWorkspaceConfigDir } from "../src/lib/worker/cli";
import { buildRepoEnv } from "../src/lib/workspace/env";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

describe("fleet config-dir isolation (DEV-126)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runtime-isolation-"));
  });

  afterEach(() => {
    delete process.env[CONFIG_DIR_ENV];
    rmSync(root, { recursive: true, force: true });
  });

  test("buildRepoEnv pins the config dir to the workspace home", () => {
    const workspaceDir = join(root, "workspace");
    const env = buildRepoEnv(
      { name: "backend", remote: "git@example.com:x/y.git", env: {} },
      workspaceDir,
    );
    expect(env[CONFIG_DIR_ENV]).toBe(join(workspaceDir, ".devintern-code"));
  });

  test("resolveProjectConfigDir prefers the override over the walk-up", () => {
    const worktree = join(root, "worktree");
    const override = join(root, "home", ".devintern-code");
    // A `.git` entry stops the ancestor walk, pinning the fallback to worktree.
    mkdirSync(join(worktree, ".git"), { recursive: true });

    delete process.env[CONFIG_DIR_ENV];
    expect(resolveProjectConfigDir(worktree)).toBe(join(worktree, ".devintern-code"));

    process.env[CONFIG_DIR_ENV] = override;
    expect(configDirOverride()).toBe(resolve(override));
    expect(resolveProjectConfigDir(worktree)).toBe(resolve(override));
  });

  test("LockManager writes the pid lock into the override, not the checkout", () => {
    const worktree = join(root, "worktree");
    const configDir = join(root, "home", ".devintern-code");
    mkdirSync(worktree, { recursive: true });
    process.env[CONFIG_DIR_ENV] = configDir;

    const lock = new LockManager(worktree);
    expect(lock.acquire().success).toBe(true);

    expect(existsSync(join(configDir, ".pid.lock"))).toBe(true);
    expect(existsSync(join(worktree, ".devintern-code", ".pid.lock"))).toBe(false);
    expect(lock.getLockFilePath()).toBe(join(configDir, ".pid.lock"));
    expect(LockManager.readLockStatus(worktree)?.path).toBe(join(configDir, ".pid.lock"));

    lock.release();
    expect(existsSync(join(configDir, ".pid.lock"))).toBe(false);
  });
});

describe("worker daemon auth/license config-dir pin (DEV-126)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runtime-daemon-config-"));
    delete process.env[CONFIG_DIR_ENV];
  });

  afterEach(() => {
    delete process.env[CONFIG_DIR_ENV];
    rmSync(root, { recursive: true, force: true });
  });

  test("daemon license gate sees the workspace session from a non-workspace cwd", () => {
    const checkoutConfigDir = join(root, "checkout", ".devintern-code");
    const workspaceDir = join(root, "workspace");
    const workspaceConfigDirPath = join(workspaceDir, ".devintern-code");
    mkdirSync(checkoutConfigDir, { recursive: true });
    mkdirSync(workspaceConfigDirPath, { recursive: true });
    const sessionFile = join(workspaceConfigDirPath, ".auth-session.json");
    writeFileSync(sessionFile, JSON.stringify({ accessToken: "a", refreshToken: "r" }));

    // Simulate a terminal launch inside an imported checkout: project config
    // resolution points at the repo, not the workspace home.
    process.env[CONFIG_DIR_ENV] = checkoutConfigDir;
    expect(loadSupabaseConfig().sessionFilePath).toBe(
      join(checkoutConfigDir, ".auth-session.json"),
    );

    // The daemon pins the selected workspace dir before the license gate.
    pinWorkspaceConfigDir(workspaceDir);

    expect(loadSupabaseConfig().sessionFilePath).toBe(sessionFile);
    expect(existsSync(sessionFile)).toBe(true);
  });
});

describe("defensive .git/info/exclude for .devintern-code (DEV-126)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "runtime-exclude-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "init"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("untracked runtime files are kept out of `git add -A`, tracked settings stay tracked", () => {
    // A repo that intentionally commits settings.json keeps working.
    mkdirSync(join(repo, ".devintern-code"), { recursive: true });
    writeFileSync(join(repo, ".devintern-code", "settings.json"), "{}\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "add settings"]);

    ensureGitInfoExcluded(repo, ".devintern-code/");
    // Idempotent: a second call adds nothing.
    ensureGitInfoExcluded(repo, ".devintern-code/");

    // Runtime artifacts appearing in the checkout stay out of the index...
    writeFileSync(join(repo, ".devintern-code", ".pid.lock"), "{}");
    writeFileSync(join(repo, ".devintern-code", "license-cache.json"), "{}");
    git(repo, ["add", "-A"]);
    const staged = git(repo, ["diff", "--cached", "--name-only"]);
    expect(staged).not.toContain(".pid.lock");
    expect(staged).not.toContain("license-cache.json");

    // ...while a change to the committed settings.json is still staged.
    writeFileSync(join(repo, ".devintern-code", "settings.json"), '{"jira":{}}\n');
    git(repo, ["add", "-A"]);
    expect(git(repo, ["diff", "--cached", "--name-only"])).toContain(
      ".devintern-code/settings.json",
    );
  });
});
