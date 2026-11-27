/**
 * Parity between the two `devintern worker init` setup paths: for the same
 * tracker, query, and repo, the interactive wizard (accepting every default)
 * and `--non-interactive` must write equivalent workspace.toml files, so a
 * headless worker behaves like one set up by hand.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runWorkerInit } from "../src/lib/init/worker-init";
import { runNonInteractiveWorkerInit } from "../src/lib/init/worker-init-noninteractive";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";

const REMOTE = "git@github.com:acme/app.git";

/**
 * Known, deliberate difference: only `--non-interactive` records the
 * checkout's detected branch as `[[repos]].default_branch` (the wizard's
 * add-repo follows origin/HEAD at run time). Everything else must match.
 */
const HEADLESS_ONLY_LINE = 'default_branch = "main"';

function withoutHeadlessOnlyLines(content: string): string {
  return content
    .split("\n")
    .filter((line) => line.trim() !== HEADLESS_ONLY_LINE)
    .join("\n");
}

/**
 * The TOML a file actually sets: every non-blank, non-comment line, sorted.
 * Ignores ordering and comments but notices any key one path writes and the
 * other does not, even when the parsed value would equal the default.
 */
function settingLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .sort();
}

const CASES = [
  {
    tracker: "jira",
    query: "project = APP AND labels = ai",
    env: {
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "bot@acme.test",
      JIRA_API_TOKEN: "ATATT-test-token",
    },
  },
  { tracker: "markdown", query: "*", env: { MARKDOWN_TASKS_DIR: "/tmp/devintern-parity-tasks" } },
] as const;

describe("worker init parity: interactive and non-interactive write the same workspace.toml", () => {
  let root: string;
  let repoDir: string;
  const savedWorkspaceDir = process.env.DEVINTERN_WORKSPACE_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "worker-init-parity-"));
    repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    execSync(`git init -q -b main && git remote add origin ${REMOTE}`, {
      cwd: repoDir,
      stdio: "ignore",
    });
  });

  afterEach(() => {
    if (savedWorkspaceDir === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspaceDir;
    rmSync(root, { recursive: true, force: true });
  });

  /** The wizard on a fresh workspace, pressing Enter at every question. */
  async function interactive(tracker: string, query: string): Promise<string> {
    const workspaceDir = join(root, "interactive");
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    const result = await runWorkerInit({
      cwd: repoDir,
      log: () => {},
      prompt: async (question) => (question.startsWith("Ready-tasks query") ? query : ""),
      ensureTracker: async () => tracker,
      detectGithubRepo: async () => null,
      checkAutomationLicense: async () => null,
      getUser: async () => null,
      signIn: async () => null,
      noService: true,
    });
    expect(result.ok).toBe(true);
    return readFileSync(join(workspaceDir, "workspace.toml"), "utf8");
  }

  /** `worker init --non-interactive --tracker … --task-query … --repo-from-cwd` on a fresh workspace. */
  async function nonInteractive(
    tracker: string,
    query: string,
    env: Record<string, string>,
    { workspaceDir = join(root, "headless"), yes = false } = {},
  ): Promise<string> {
    const report = await runNonInteractiveWorkerInit(
      { tracker, taskQuery: query, repoFromCwd: true, json: true, yes },
      {
        cwd: repoDir,
        workspaceDir,
        processEnv: { ...env },
        probe: async () => {},
        probeTimeoutMs: 2_000,
        doctor: {
          dryRunQuery: async () => 1,
          checkRepoAccess: async () => ({ ok: true, detail: "readable" }),
          checkEntitlement: async () => ({ valid: true, source: "license-key", message: "ok" }),
          checkHarness: async () => ({ id: "harness", label: "Agent harness", status: "ok" }),
          checkSandbox: async () => ({ id: "sandbox", label: "Agent sandbox", status: "ok" }),
          checkGitIdentity: async () => ({ id: "git-identity", label: "Git", status: "ok" }),
          isPortInUse: async () => false,
          workerStatus: () => ({ status: "stopped" }),
        },
      },
    );
    expect(report.error).toBeUndefined();
    expect(report.persisted).toBe(true);
    expect(report.filesWritten).toContain(join(workspaceDir, "workspace.toml"));
    return readFileSync(join(workspaceDir, "workspace.toml"), "utf8");
  }

  for (const { tracker, query, env } of CASES) {
    test(`${tracker}: same settings, recommended worker policy written explicitly`, async () => {
      const wizard = await interactive(tracker, query);
      const headlessRaw = await nonInteractive(tracker, query, env);
      expect(headlessRaw).toContain(HEADLESS_ONLY_LINE);
      const headless = withoutHeadlessOnlyLines(headlessRaw);

      expect(settingLines(headless)).toEqual(settingLines(wizard));
      const configPath = join(root, "workspace.toml");
      expect(parseWorkspaceConfig(headless, configPath)).toEqual(
        parseWorkspaceConfig(wizard, configPath),
      );
      // Both name the recommended settings rather than relying on defaults.
      for (const content of [wizard, headless]) {
        expect(content).toContain("ci_failure_fix = false");
        expect(content).toContain('conflict_resolution = "auto"');
        expect(content).toContain("[worker.schedule]");
        expect(content).toContain("active = []");
      }
    });
  }

  test("an existing workspace keeps its custom worker settings", async () => {
    const workspaceDir = join(root, "existing");
    const env = CASES[1].env;
    await nonInteractive("markdown", "*", env, { workspaceDir });
    const configPath = join(workspaceDir, "workspace.toml");
    const custom = readFileSync(configPath, "utf8")
      .replace("ci_failure_fix = false", "ci_failure_fix = true")
      .replace('conflict_resolution = "auto"', 'conflict_resolution = "disabled"')
      .replace("active = []", 'active = ["22:00-06:00"]');
    writeFileSync(configPath, custom);

    const rerun = await nonInteractive("markdown", "status = todo", env, {
      workspaceDir,
      yes: true,
    });
    const config = parseWorkspaceConfig(rerun, configPath);
    expect(config.defaults.taskQuery).toBe("status = todo");
    expect(config.workspace.ciFailureFix).toBe(true);
    expect(config.workspace.conflictResolution).toBe("disabled");
    expect(config.worker.schedule?.active.map((window) => window.spec)).toEqual(["22:00-06:00"]);
  });
});
