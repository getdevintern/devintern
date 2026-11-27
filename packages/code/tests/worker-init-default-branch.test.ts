/**
 * The interactive wizard records the branch tasks start from and pull requests
 * target (`[[repos]].default_branch`): silently when the checkout is on the
 * remote's default branch, with a question when it is on another branch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runWorkerInit } from "../src/lib/init/worker-init";
import { loadWorkspaceConfig, parseWorkspaceConfig } from "../src/lib/workspace/config";
import { upsertRepoDefaultBranch } from "../src/lib/workspace/init";

const REMOTE = "git@github.com:acme/app.git";

describe("upsertRepoDefaultBranch", () => {
  const content = `[defaults]
tracker = "markdown"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
[repos.env]
GITHUB_REPO = "acme/web"
`;

  function repos(text: string) {
    return parseWorkspaceConfig(text, "workspace.toml").repos;
  }

  test("adds the key to the named entry before its env sub-table", () => {
    const updated = upsertRepoDefaultBranch(content, "web", "develop");
    expect(updated).toContain('default_branch = "develop"\n[repos.env]');
    expect(repos(updated).find((repo) => repo.name === "web")?.defaultBranch).toBe("develop");
    expect(repos(updated).find((repo) => repo.name === "api")?.defaultBranch).toBeUndefined();
  });

  test("updates the key in place on a re-run", () => {
    const once = upsertRepoDefaultBranch(content, "web", "develop");
    const twice = upsertRepoDefaultBranch(once, "web", "main");
    expect(twice.match(/default_branch =/g)).toHaveLength(1);
    expect(repos(twice).find((repo) => repo.name === "web")?.defaultBranch).toBe("main");
  });
});

describe("worker init interactive default_branch", () => {
  let root: string;
  let repoDir: string;
  let workspaceDir: string;
  const savedWorkspaceDir = process.env.DEVINTERN_WORKSPACE_DIR;

  function git(command: string): void {
    execSync(`git ${command}`, {
      cwd: repoDir,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "worker-init-default-branch-"));
    repoDir = join(root, "repo");
    workspaceDir = join(root, "workspace");
    mkdirSync(repoDir, { recursive: true });
    git("init -q -b main");
    writeFileSync(join(repoDir, "README.md"), "# app\n");
    git("add README.md");
    git("commit -q -m init");
    git(`remote add origin ${REMOTE}`);
    // What a clone records for the remote's default branch, without a network call.
    git("update-ref refs/remotes/origin/main HEAD");
    git("symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
  });

  afterEach(() => {
    if (savedWorkspaceDir === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspaceDir;
    rmSync(root, { recursive: true, force: true });
  });

  function config() {
    return loadWorkspaceConfig(join(workspaceDir, "workspace.toml"));
  }

  /** Run the wizard; `answer` replies to the PR-target question, `""` means Enter. */
  async function runWizard(answer: (question: string) => string): Promise<string[]> {
    const questions: string[] = [];
    const result = await runWorkerInit({
      cwd: repoDir,
      log: () => {},
      prompt: async (question) => {
        questions.push(question);
        if (question.startsWith("Open PRs against")) return answer(question);
        if (question.startsWith("Ready-tasks query")) return "*";
        return "";
      },
      ensureTracker: async () => "markdown",
      detectGithubRepo: async () => null,
      checkAutomationLicense: async () => null,
      getUser: async () => null,
      signIn: async () => null,
      noService: true,
    });
    expect(result.ok).toBe(true);
    return questions;
  }

  test("a checkout on another branch asks and saves the answer", async () => {
    git("checkout -q -b feature/pr-base");
    const questions = await runWizard(() => "feature/pr-base");

    expect(questions).toContain("Open PRs against feature/pr-base or main? [main]: ");
    expect(config().repos[0]?.defaultBranch).toBe("feature/pr-base");
  });

  test("a checkout on the default branch saves it silently", async () => {
    let asked = false;
    const questions = await runWizard(() => {
      asked = true;
      return "";
    });

    expect(asked).toBe(false);
    expect(questions.some((question) => question.startsWith("Open PRs against"))).toBe(false);
    expect(config().repos[0]?.defaultBranch).toBe("main");
  });

  test("a re-run offers the saved branch and Enter keeps it", async () => {
    git("checkout -q -b feature/pr-base");
    await runWizard(() => "feature/pr-base");
    expect(config().repos[0]?.defaultBranch).toBe("feature/pr-base");

    const questions = await runWizard(() => "");

    const question = questions.find((candidate) =>
      candidate.startsWith("Open PRs against feature/pr-base or main?"),
    );
    expect(question).toContain("[feature/pr-base]");
    expect(config().repos[0]?.defaultBranch).toBe("feature/pr-base");
  });
});
