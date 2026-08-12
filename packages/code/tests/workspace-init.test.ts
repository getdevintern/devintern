import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadWorkspaceConfig } from "../src/lib/workspace/config";
import { runWorkspaceImport, runWorkspaceInit } from "../src/lib/workspace/init";
import { workspaceConfigPath, workspaceEnvPath } from "../src/lib/workspace/paths";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
}

describe("workspace init/import", () => {
  let rootDir: string;
  let workspaceDir: string;
  let repoDir: string;
  let originDir: string;
  let previousOverride: string | undefined;

  beforeEach(() => {
    rootDir = join(tmpdir(), `ws-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspaceDir = join(rootDir, "workspace");
    repoDir = join(rootDir, "repo");
    originDir = join(rootDir, "origin.git");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(originDir, { recursive: true });

    previousOverride = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;

    // Fixture repo with an origin remote (bare) and a per-repo env.
    git(originDir, "init --bare -b main");
    git(repoDir, "init -b main");
    git(repoDir, 'config user.name "Fixture User"');
    git(repoDir, 'config user.email "fixture@example.com"');
    writeFileSync(join(repoDir, "README.md"), "# Fixture\n");
    git(repoDir, "add .");
    git(repoDir, 'commit -m "Initial commit"');
    git(repoDir, `remote add origin ${originDir}`);
    git(repoDir, "push -u origin main");
    git(repoDir, "remote set-head origin -a");

    mkdirSync(join(repoDir, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(repoDir, ".devintern-code", ".env"),
      "JIRA_BASE_URL=https://acme.atlassian.net\n" +
        "JIRA_DEFAULT_PROJECT_KEY=BACK\n" +
        "GITHUB_TOKEN=repo-token\n" +
        "WEBHOOK_QUEUE_DB=/tmp/ignore.db\n",
    );
  });

  afterEach(() => {
    if (previousOverride === undefined) {
      delete process.env.DEVINTERN_WORKSPACE_DIR;
    } else {
      process.env.DEVINTERN_WORKSPACE_DIR = previousOverride;
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  test("init scaffolds a valid config and refuses to overwrite", () => {
    expect(runWorkspaceInit()).toBe(0);
    expect(existsSync(workspaceConfigPath())).toBe(true);
    expect(existsSync(workspaceEnvPath())).toBe(true);

    const config = loadWorkspaceConfig(workspaceConfigPath());
    expect(config.defaults.tracker).toBe("jira");
    expect(config.repos).toEqual([]);

    expect(runWorkspaceInit()).toBe(1); // second run refuses
  });

  test("import adds the repo, merges env, and seeds a routing rule", async () => {
    runWorkspaceInit();
    expect(await runWorkspaceImport(repoDir)).toBe(0);

    const config = loadWorkspaceConfig(workspaceConfigPath());
    expect(config.repos).toHaveLength(1);
    expect(config.repos[0].name).toBe("origin");
    expect(config.repos[0].remote).toBe(originDir);
    expect(config.routing).toEqual([
      { repo: "origin", project: "BACK", components: [], labels: [] },
    ]);

    const env = readFileSync(workspaceEnvPath(), "utf8");
    expect(env).toContain("JIRA_BASE_URL=https://acme.atlassian.net");
    expect(env).toContain("GITHUB_TOKEN=repo-token");
    expect(env).not.toContain("WEBHOOK_QUEUE_DB");
  });

  test("import is idempotent and demotes conflicting env values to [repos.env]", async () => {
    runWorkspaceInit();
    // Pre-seed a conflicting shared value.
    writeFileSync(workspaceEnvPath(), "GITHUB_TOKEN=shared-token\n");

    expect(await runWorkspaceImport(repoDir)).toBe(0);
    const config = loadWorkspaceConfig(workspaceConfigPath());
    expect(config.repos[0].env).toEqual({ GITHUB_TOKEN: "repo-token" });
    // Shared value untouched.
    expect(readFileSync(workspaceEnvPath(), "utf8")).toContain("GITHUB_TOKEN=shared-token");

    // Second import: no duplicate entry, config identical.
    const before = readFileSync(workspaceConfigPath(), "utf8");
    expect(await runWorkspaceImport(repoDir)).toBe(0);
    expect(readFileSync(workspaceConfigPath(), "utf8")).toBe(before);
    expect(loadWorkspaceConfig(workspaceConfigPath()).repos).toHaveLength(1);
  });

  test("import preserves hand-written comments in the existing config", async () => {
    runWorkspaceInit();
    const configPath = workspaceConfigPath();
    const withComment = readFileSync(configPath, "utf8") + "\n# my custom note\n";
    writeFileSync(configPath, withComment);

    await runWorkspaceImport(repoDir);
    expect(readFileSync(configPath, "utf8")).toContain("# my custom note");
  });

  test("import fails cleanly without a workspace or origin remote", async () => {
    expect(await runWorkspaceImport(repoDir)).toBe(1); // no workspace yet

    runWorkspaceInit();
    const bareDir = join(rootDir, "no-remote");
    mkdirSync(bareDir, { recursive: true });
    git(bareDir, "init -b main");
    expect(await runWorkspaceImport(bareDir)).toBe(1); // no origin remote
  });
});
