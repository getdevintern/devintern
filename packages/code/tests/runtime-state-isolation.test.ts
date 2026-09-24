/**
 * Regression coverage for DEV-126: worker task runs must resolve durable
 * state to the workspace home, and a repo checkout must never have
 * `.devintern-code/` runtime artifacts staged into a PR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  resolveProjectConfigDir,
  resolveRuntimeStateDir,
  WORKER_SUBPROCESS_ENV,
} from "../src/lib/config/config-dir";
import { loadSupabaseConfig } from "../src/lib/cli/bootstrap";
import { excludeWorkerRuntimeFiles } from "../src/lib/utils/git-exclude";
import { buildRepoEnv } from "../src/lib/workspace/env";
import { ensureWorkspaceCodeState } from "../src/lib/workspace/paths";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

describe("fleet config-dir isolation (DEV-126)", () => {
  let root: string;
  const priorWorkspace = process.env.DEVINTERN_WORKSPACE_DIR;
  const priorMarker = process.env[WORKER_SUBPROCESS_ENV];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runtime-isolation-"));
  });

  afterEach(() => {
    if (priorWorkspace === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = priorWorkspace;
    if (priorMarker === undefined) delete process.env[WORKER_SUBPROCESS_ENV];
    else process.env[WORKER_SUBPROCESS_ENV] = priorMarker;
    rmSync(root, { recursive: true, force: true });
  });

  test("buildRepoEnv passes workspace context to task subprocesses", () => {
    const workspaceDir = join(root, "workspace");
    const env = buildRepoEnv(
      { name: "backend", remote: "git@example.com:x/y.git", env: {} },
      workspaceDir,
    );
    expect(env.DEVINTERN_WORKSPACE_DIR).toBe(workspaceDir);
    expect(env[WORKER_SUBPROCESS_ENV]).toBe("1");
  });

  test("worker subprocesses use workspace state while normal runs stay project scoped", () => {
    const worktree = join(root, "worktree");
    const workspace = join(root, "workspace");
    // A `.git` entry stops the ancestor walk, pinning the fallback to worktree.
    mkdirSync(join(worktree, ".git"), { recursive: true });

    delete process.env[WORKER_SUBPROCESS_ENV];
    expect(resolveProjectConfigDir(worktree)).toBe(join(worktree, ".devintern-code"));
    expect(resolveRuntimeStateDir(worktree)).toBe(join(worktree, ".devintern-code"));
    process.env.DEVINTERN_WORKSPACE_DIR = workspace;
    process.env[WORKER_SUBPROCESS_ENV] = "1";
    expect(resolveRuntimeStateDir(worktree)).toBe(join(workspace, "state", "code"));
    expect(resolveProjectConfigDir(worktree)).toBe(join(worktree, ".devintern-code"));
  });
});

describe("worker daemon auth/license state (DEV-126)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runtime-daemon-config-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("daemon license gate sees the workspace session from a non-workspace cwd", () => {
    const checkoutConfigDir = join(root, "checkout", ".devintern-code");
    const workspaceDir = join(root, "workspace");
    const workspaceConfigDirPath = join(workspaceDir, "state", "code");
    mkdirSync(checkoutConfigDir, { recursive: true });
    mkdirSync(workspaceConfigDirPath, { recursive: true });
    const sessionFile = join(workspaceConfigDirPath, ".auth-session.json");
    writeFileSync(sessionFile, JSON.stringify({ accessToken: "a", refreshToken: "r" }));

    expect(loadSupabaseConfig(checkoutConfigDir).sessionFilePath).toBe(
      join(checkoutConfigDir, ".auth-session.json"),
    );
    expect(loadSupabaseConfig(workspaceConfigDirPath).sessionFilePath).toBe(sessionFile);
    expect(existsSync(sessionFile)).toBe(true);
  });

  test("moves existing workspace auth and relay state without replacing new files", () => {
    const workspace = join(root, "workspace");
    const legacy = join(workspace, ".devintern-code");
    const current = join(workspace, "state", "code");
    mkdirSync(legacy, { recursive: true });
    mkdirSync(current, { recursive: true });
    writeFileSync(join(legacy, ".auth-session.json"), "old-session");
    writeFileSync(join(legacy, "relay.json"), "old-relay");
    writeFileSync(join(current, ".auth-session.json"), "new-session");
    ensureWorkspaceCodeState(workspace);
    expect(readFileSync(join(current, ".auth-session.json"), "utf8")).toBe("new-session");
    expect(readFileSync(join(current, "relay.json"), "utf8")).toBe("old-relay");
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

  test("runtime files stay out of git while new project config remains stageable", () => {
    mkdirSync(join(repo, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(repo, ".gitignore"),
      ".devintern-code/*\n!.devintern-code/settings.json\n!.devintern-code/.env.example\n!.devintern-code/automations.toml\n",
    );
    excludeWorkerRuntimeFiles(repo);
    excludeWorkerRuntimeFiles(repo);

    // Runtime artifacts appearing in the checkout stay out of the index...
    writeFileSync(join(repo, ".devintern-code", ".pid.lock"), "{}");
    writeFileSync(join(repo, ".devintern-code", "license-cache.json"), "{}");
    writeFileSync(join(repo, ".devintern-code", "queue.db-wal"), "{}");
    writeFileSync(join(repo, ".devintern-code", "settings.json"), "{}\n");
    writeFileSync(join(repo, ".devintern-code", ".env.example"), "EXAMPLE=1\n");
    writeFileSync(join(repo, ".devintern-code", "automations.toml"), "# schedules\n");
    git(repo, ["add", "-A"]);
    const staged = git(repo, ["diff", "--cached", "--name-only"]);
    expect(staged).not.toContain(".pid.lock");
    expect(staged).not.toContain("license-cache.json");
    expect(staged).not.toContain("queue.db-wal");
    expect(staged).toContain(".devintern-code/settings.json");
    expect(staged).toContain(".devintern-code/.env.example");
    expect(staged).toContain(".devintern-code/automations.toml");
  });
});
