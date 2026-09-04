import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadWorkspaceConfig } from "../src/lib/workspace/config";
import {
  runWorkerAddRepo,
  runWorkerScaffold,
  upsertWorkspaceDefaults,
} from "../src/lib/workspace/init";
import { workspaceConfigPath, workspaceEnvPath } from "../src/lib/workspace/paths";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
}

describe("worker scaffold/add-repo", () => {
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

  test("scaffold creates a valid config and refuses to overwrite", () => {
    expect(runWorkerScaffold()).toBe(0);
    expect(existsSync(workspaceConfigPath())).toBe(true);
    expect(existsSync(workspaceEnvPath())).toBe(true);

    const config = loadWorkspaceConfig(workspaceConfigPath());
    expect(config.defaults.tracker).toBe("jira");
    expect(config.repos).toEqual([]);

    expect(runWorkerScaffold()).toBe(1); // second run refuses
  });

  test("scaffold has no bare # comment lines (Bun.TOML redefinition bug)", () => {
    // Bun 1.3.2's TOML parser mis-attributes keys to the previous table when
    // a "#"-only comment line precedes an [[array.of.tables]] header, failing
    // with "Cannot redefine key". Keep whitespace after every "#" in templates.
    expect(runWorkerScaffold()).toBe(0);
    const text = readFileSync(workspaceConfigPath(), "utf8");
    expect(text).not.toMatch(/^#$/m);

    // Reproduce the parser bug's trigger: an uncommented table header after
    // the scaffold's comment block.
    const withAutomation =
      text +
      '\n[[automations]]\nid = "weekday-maintenance"\nenabled = true\n' +
      'cron = "0 9 * * 1-5"\nprompt = "p"\nrepo = "backend"\n';
    Bun.TOML.parse(withAutomation);
  });

  test("add-repo adds the repo, merges env, and seeds a routing rule", async () => {
    runWorkerScaffold();
    expect(await runWorkerAddRepo(repoDir)).toBe(0);

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

  test("add-repo from a package subdirectory still merges the repo-root .env", async () => {
    runWorkerScaffold();
    const nested = join(repoDir, "packages", "code");
    mkdirSync(nested, { recursive: true });

    expect(await runWorkerAddRepo(nested)).toBe(0);

    const env = readFileSync(workspaceEnvPath(), "utf8");
    expect(env).toContain("JIRA_BASE_URL=https://acme.atlassian.net");
    expect(env).toContain("GITHUB_TOKEN=repo-token");
  });

  test("add-repo is idempotent and demotes conflicting env values to [repos.env]", async () => {
    runWorkerScaffold();
    // Pre-seed a conflicting shared value.
    writeFileSync(workspaceEnvPath(), "GITHUB_TOKEN=shared-token\n");

    expect(await runWorkerAddRepo(repoDir)).toBe(0);
    const config = loadWorkspaceConfig(workspaceConfigPath());
    expect(config.repos[0].env).toEqual({ GITHUB_TOKEN: "repo-token" });
    // Shared value untouched.
    expect(readFileSync(workspaceEnvPath(), "utf8")).toContain("GITHUB_TOKEN=shared-token");

    // Second add: no duplicate entry, config identical. Missing workspace
    // keys still merge (re-running worker init from a subdirectory).
    const nested = join(repoDir, "packages", "code");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repoDir, ".devintern-code", ".env"), "JIRA_EMAIL=dev@acme.test\n", {
      flag: "a",
    });
    const before = readFileSync(workspaceConfigPath(), "utf8");
    expect(await runWorkerAddRepo(nested)).toBe(0);
    expect(readFileSync(workspaceConfigPath(), "utf8")).toBe(before);
    expect(loadWorkspaceConfig(workspaceConfigPath()).repos).toHaveLength(1);
    expect(readFileSync(workspaceEnvPath(), "utf8")).toContain("JIRA_EMAIL=dev@acme.test");
  });

  test("add-repo preserves hand-written comments in the existing config", async () => {
    runWorkerScaffold();
    const configPath = workspaceConfigPath();
    const withComment = readFileSync(configPath, "utf8") + "\n# my custom note\n";
    writeFileSync(configPath, withComment);

    await runWorkerAddRepo(repoDir);
    expect(readFileSync(configPath, "utf8")).toContain("# my custom note");
  });

  test("upsertWorkspaceDefaults uncomments task_query and sets tracker", () => {
    runWorkerScaffold();
    const before = readFileSync(workspaceConfigPath(), "utf8");
    const updated = upsertWorkspaceDefaults(before, {
      tracker: "markdown",
      taskQuery: "project = PROJ AND status = 'To Do'",
    });
    expect(updated).toContain('tracker = "markdown"');
    expect(updated).not.toMatch(/^tracker = "jira"$/m);
    expect(updated).toContain(`task_query = "project = PROJ AND status = 'To Do'"`);
    expect(updated).not.toContain(
      '# task_query = "sprint in openSprints() AND labels = devintern"',
    );
    expect(updated).toContain("# Days before a leftover");
  });

  test("upsertWorkspaceDefaults only edits the defaults table", () => {
    const updated = upsertWorkspaceDefaults(
      `[defaults]
tracker = "jira"

[[repos]]
name = "app"
remote = "git@github.com:acme/app.git"
  [repos.env]
  tracker = "repo-specific"
  task_query = "leave-me-alone"
`,
      { tracker: "linear", taskQuery: "status = Todo" },
    );
    expect(updated).toContain('[defaults]\ntracker = "linear"\ntask_query = "status = Todo"');
    expect(updated).toContain('  tracker = "repo-specific"');
    expect(updated).toContain('  task_query = "leave-me-alone"');
  });

  test("add-repo fails cleanly without a workspace or origin remote", async () => {
    expect(await runWorkerAddRepo(repoDir)).toBe(1); // no workspace yet

    runWorkerScaffold();
    const bareDir = join(rootDir, "no-remote");
    mkdirSync(bareDir, { recursive: true });
    git(bareDir, "init -b main");
    expect(await runWorkerAddRepo(bareDir)).toBe(1); // no origin remote
  });
});
