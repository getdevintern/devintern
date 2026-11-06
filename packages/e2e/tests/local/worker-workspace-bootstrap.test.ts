import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isolatedEnvironment } from "../../helpers/environment";
import { cliPath } from "../../helpers/fixture-workspace";
import { command, checkedCommand } from "../../helpers/process";

const cliTest = test.skipIf(!existsSync(cliPath));

interface BootstrapFixture {
  root: string;
  env: Record<string, string>;
  workspaceDir: string;
  configPath: string;
  envPath: string;
}

interface SeededRepository {
  remoteDir: string;
  repoDir: string;
  repoName: string;
}

interface ParsedWorkspaceConfig {
  repos: Array<{ name: string; remote: string }>;
  routing?: { rules: Array<{ repo: string; project?: string }> };
}

/**
 * Parse the generated TOML as data so assertions cannot accidentally match
 * the commented examples in the scaffold template.
 */
function parseWorkspaceConfigAt(configPath: string): ParsedWorkspaceConfig {
  return Bun.TOML.parse(readFileSync(configPath, "utf8")) as ParsedWorkspaceConfig;
}

function createFixture(): BootstrapFixture {
  const root = mkdtempSync(join(tmpdir(), "devintern-e2e-worker-bootstrap-"));
  const env = isolatedEnvironment(root);
  const workspaceDir = env.DEVINTERN_WORKSPACE_DIR!;
  return {
    root,
    env,
    workspaceDir,
    configPath: join(workspaceDir, "workspace.toml"),
    envPath: join(workspaceDir, ".env"),
  };
}

function runCli(
  fixture: BootstrapFixture,
  args: string[],
  cwd: string = fixture.root,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return command([process.execPath, cliPath, ...args], cwd, fixture.env);
}

/** Create a local bare remote plus a checkout whose origin points at it. */
async function seedRepository(fixture: BootstrapFixture): Promise<SeededRepository> {
  // The space proves the derived [[repos]] name is filesystem-safe.
  const remoteDir = join(fixture.root, "remotes", "acme app.git");
  mkdirSync(dirname(remoteDir), { recursive: true });
  await checkedCommand(
    ["git", "init", "--bare", "--initial-branch", "main", remoteDir],
    fixture.root,
    fixture.env,
  );

  const repoDir = join(fixture.root, "checkouts", "acme app");
  mkdirSync(repoDir, { recursive: true });
  await checkedCommand(["git", "init", "--initial-branch", "main"], repoDir, fixture.env);
  writeFileSync(join(repoDir, "README.md"), "# Fixture\n");
  await checkedCommand(["git", "add", "."], repoDir, fixture.env);
  await checkedCommand(["git", "commit", "-m", "Initial commit"], repoDir, fixture.env);
  await checkedCommand(["git", "remote", "add", "origin", remoteDir], repoDir, fixture.env);
  await checkedCommand(["git", "push", "--set-upstream", "origin", "main"], repoDir, fixture.env);
  // A symbolic origin/HEAD exists so a regression that pins it would show up.
  await checkedCommand(["git", "remote", "set-head", "origin", "-a"], repoDir, fixture.env);

  return { remoteDir, repoDir, repoName: "acme-app" };
}

function writeRepoEnv(repoDir: string, contents: string): void {
  mkdirSync(join(repoDir, ".devintern-code"), { recursive: true });
  writeFileSync(join(repoDir, ".devintern-code", ".env"), contents);
}

function cleanup(fixture: BootstrapFixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

cliTest(
  "worker scaffold creates the workspace and refuses to overwrite it",
  async () => {
    const fixture = createFixture();
    try {
      const scaffold = await runCli(fixture, ["worker", "scaffold"]);
      expect(scaffold.exitCode, scaffold.stderr).toBe(0);
      expect(existsSync(fixture.configPath)).toBe(true);
      expect(existsSync(fixture.envPath)).toBe(true);
      expect(statSync(fixture.envPath).mode & 0o777).toBe(0o600);

      const config = readFileSync(fixture.configPath, "utf8");
      expect(config).toContain("[workspace]");
      expect(config).toContain("[defaults]");
      expect(config).toContain('tracker = "jira"');
      expect(config).toContain("# [[repos]]");
      expect(config).toContain("# [[automations]]");
      expect(config).toContain('remote = "git@github.com:acme/backend.git"');
      expect(readFileSync(fixture.envPath, "utf8")).toContain("# Shared workspace environment");

      // A follow-up command loads the generated TOML through the real parser and
      // schema. There are no repos yet, so it stops at the documented check.
      const loaded = await runCli(fixture, [
        "worker",
        "add",
        "--title",
        "Scaffold smoke",
        "--json",
      ]);
      expect(loaded.exitCode).not.toBe(0);
      expect(loaded.stderr).toContain("No repos configured");

      const configBefore = readFileSync(fixture.configPath);
      const envBefore = readFileSync(fixture.envPath);
      const second = await runCli(fixture, ["worker", "scaffold"]);
      expect(second.exitCode).not.toBe(0);
      expect(second.stderr).toContain("already exists");
      expect(second.stderr).toContain("refusing to overwrite");
      expect(readFileSync(fixture.configPath)).toEqual(configBefore);
      expect(readFileSync(fixture.envPath)).toEqual(envBefore);
      expect(statSync(fixture.envPath).mode & 0o777).toBe(0o600);
    } finally {
      cleanup(fixture);
    }
  },
  120_000,
);

cliTest(
  "worker add-repo registers the remote, merges env, demotes conflicts, and seeds routing",
  async () => {
    const fixture = createFixture();
    try {
      expect((await runCli(fixture, ["worker", "scaffold"])).exitCode).toBe(0);
      const { remoteDir, repoDir, repoName } = await seedRepository(fixture);
      writeRepoEnv(
        repoDir,
        [
          "JIRA_BASE_URL=https://acme.atlassian.net",
          "JIRA_DEFAULT_PROJECT_KEY=BACK",
          "GITHUB_TOKEN=repo-token",
          "WEBHOOK_QUEUE_DB=/tmp/ignore.db",
          "",
        ].join("\n"),
      );
      // The shared value must win; the repo value is demoted, never overwritten.
      writeFileSync(fixture.envPath, "GITHUB_TOKEN=shared-token\n");

      const addRepo = await runCli(fixture, ["worker", "add-repo"], repoDir);
      expect(addRepo.exitCode, addRepo.stderr).toBe(0);
      expect(addRepo.stdout).toContain(`Added ${remoteDir} as "${repoName}"`);

      const config = readFileSync(fixture.configPath, "utf8");
      expect(config).toContain("[[repos]]");
      expect(config).toContain(`name = "${repoName}"`);
      expect(config).toContain(`remote = "${remoteDir}"`);
      // origin/HEAD is transient; add-repo must not pin it as a default branch.
      expect(config).not.toMatch(/^default_branch\s*=/m);

      // The repo's default project key seeds a starter routing rule. Parse the
      // document so the template's commented examples cannot satisfy this.
      const parsedConfig = parseWorkspaceConfigAt(fixture.configPath);
      expect(parsedConfig.repos).toHaveLength(1);
      expect(parsedConfig.repos[0]).toMatchObject({ name: repoName, remote: remoteDir });
      expect(parsedConfig.routing?.rules).toEqual([{ repo: repoName, project: "BACK" }]);

      // The conflicting value stays repo-local, not written over the shared one.
      expect(config).toMatch(/\[repos\.env\]\n\s+GITHUB_TOKEN = "repo-token"/);
      const env = readFileSync(fixture.envPath, "utf8");
      expect(env).toContain("GITHUB_TOKEN=shared-token");
      expect(env).not.toContain("GITHUB_TOKEN=repo-token");
      // Missing keys merged; the worker-owned queue path is never exported.
      expect(env).toContain("JIRA_BASE_URL=https://acme.atlassian.net");
      expect(env).toContain("JIRA_DEFAULT_PROJECT_KEY=BACK");
      expect(env).not.toContain("WEBHOOK_QUEUE_DB");
      expect(statSync(fixture.envPath).mode & 0o777).toBe(0o600);

      // Loading the generated TOML through `worker add` proves it parses and
      // validates, not merely that it was written.
      const added = await runCli(fixture, [
        "worker",
        "add",
        "--title",
        "Parse the generated workspace",
        "--body",
        "Load workspace.toml through the real CLI.",
        "--json",
      ]);
      expect(added.exitCode, added.stderr).toBe(0);
      const parsed = JSON.parse(added.stdout.trim()) as { repo: string; status: string };
      expect(parsed).toMatchObject({ repo: repoName, status: "pending" });
    } finally {
      cleanup(fixture);
    }
  },
  180_000,
);

cliTest(
  "worker add-repo is idempotent and reads the repo-root env from a subdirectory",
  async () => {
    const fixture = createFixture();
    try {
      expect((await runCli(fixture, ["worker", "scaffold"])).exitCode).toBe(0);
      const { repoDir, repoName } = await seedRepository(fixture);
      writeRepoEnv(repoDir, "JIRA_EMAIL=dev@acme.test\nLINEAR_DEFAULT_TEAM_KEY=ENG\n");

      const nested = join(repoDir, "packages", "code");
      mkdirSync(nested, { recursive: true });
      const first = await runCli(fixture, ["worker", "add-repo"], nested);
      expect(first.exitCode, first.stderr).toBe(0);
      // The package subdirectory still resolves the repository-root env file.
      expect(readFileSync(fixture.envPath, "utf8")).toContain("JIRA_EMAIL=dev@acme.test");
      // The Linear team key seeds the same starter routing rule as a Jira project.
      expect(parseWorkspaceConfigAt(fixture.configPath).routing?.rules).toEqual([
        { repo: repoName, project: "ENG" },
      ]);

      const configBefore = readFileSync(fixture.configPath);
      const envBefore = readFileSync(fixture.envPath);
      const second = await runCli(fixture, ["worker", "add-repo"], repoDir);
      expect(second.exitCode, second.stderr).toBe(0);
      expect(second.stdout).toContain("already in the workspace");
      expect(readFileSync(fixture.configPath)).toEqual(configBefore);
      expect(readFileSync(fixture.envPath)).toEqual(envBefore);

      const config = readFileSync(fixture.configPath, "utf8");
      expect(config.match(/^\[\[repos\]\]$/gm)).toHaveLength(1);
      expect(config).toContain(`name = "${repoName}"`);
    } finally {
      cleanup(fixture);
    }
  },
  180_000,
);

cliTest(
  "worker add-repo refuses a missing workspace and a repo without an origin",
  async () => {
    const fixture = createFixture();
    try {
      const { repoDir } = await seedRepository(fixture);

      const noWorkspace = await runCli(fixture, ["worker", "add-repo"], repoDir);
      expect(noWorkspace.exitCode).not.toBe(0);
      expect(noWorkspace.stderr).toContain("No workspace found");
      expect(noWorkspace.stderr).toContain("worker scaffold");
      expect(existsSync(fixture.workspaceDir)).toBe(false);

      expect((await runCli(fixture, ["worker", "scaffold"])).exitCode).toBe(0);
      const configBefore = readFileSync(fixture.configPath);
      const envBefore = readFileSync(fixture.envPath);

      const noOrigin = join(fixture.root, "checkouts", "no-origin");
      mkdirSync(noOrigin, { recursive: true });
      await checkedCommand(["git", "init", "--initial-branch", "main"], noOrigin, fixture.env);
      const noRemote = await runCli(fixture, ["worker", "add-repo"], noOrigin);
      expect(noRemote.exitCode).not.toBe(0);
      expect(noRemote.stderr).toContain("Could not read the origin remote here");
      expect(noRemote.stderr).toContain("git repo with an origin");
      expect(readFileSync(fixture.configPath)).toEqual(configBefore);
      expect(readFileSync(fixture.envPath)).toEqual(envBefore);
      expect(readFileSync(fixture.configPath, "utf8")).not.toMatch(/^\[\[repos\]\]$/m);
    } finally {
      cleanup(fixture);
    }
  },
  120_000,
);
