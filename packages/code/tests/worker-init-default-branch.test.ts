/**
 * The interactive wizard records `[[repos]].default_branch`, the base task
 * worktrees and task PRs use: silently when the checkout is on the remote's
 * default branch, with a question when it is on another branch.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PromptAttemptsExceededError } from "@devintern/task-trackers";

import { runWorkerInit } from "../src/lib/init/worker-init";
import { Utils } from "../src/lib/utils";
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

  /** Run the wizard; `answer` replies to the base-branch question, `""` means Enter. */
  async function runWizard(
    answer: (question: string) => string,
    logs: string[] = [],
  ): Promise<string[]> {
    const questions: string[] = [];
    const result = await runWorkerInit({
      cwd: repoDir,
      log: (message) => logs.push(message),
      prompt: async (question) => {
        questions.push(question);
        if (question.startsWith("Base tasks and PRs on")) return answer(question);
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

  /** Put the checkout's current branch on origin, as a fetched remote would. */
  function publishCurrentBranch(): void {
    git("update-ref refs/remotes/origin/feature/pr-base HEAD");
  }

  test("a checkout on another branch asks and saves a branch that exists on origin", async () => {
    git("checkout -q -b feature/pr-base");
    writeFileSync(join(repoDir, "base.txt"), "base\n");
    git("add base.txt");
    git("commit -q -m 'feature base'");
    publishCurrentBranch();
    const questions = await runWizard(() => "feature/pr-base");

    expect(questions).toContain("Base tasks and PRs on feature/pr-base or main? [main]: ");
    expect(config().repos[0]?.defaultBranch).toBe("feature/pr-base");

    // The saved branch is what createFeatureBranch uses for the task branch and
    // what the worker passes through as --pr-target-branch.
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const branch = await Utils.createFeatureBranch("TEST-1", config().repos[0]?.defaultBranch, {
        cwd: repoDir,
      });
      expect(branch.success).toBe(true);
    } finally {
      log.mockRestore();
    }
    const subjects = execSync("git log --format=%s feature/test-1", {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(subjects).toContain("feature base");
  });

  test("a checkout on the default branch saves it silently", async () => {
    let asked = false;
    const questions = await runWizard(() => {
      asked = true;
      return "";
    });

    expect(asked).toBe(false);
    expect(questions.some((question) => question.startsWith("Base tasks and PRs on"))).toBe(false);
    expect(config().repos[0]?.defaultBranch).toBe("main");
  });

  test("a checkout on an unpushed branch is not saved", async () => {
    git("checkout -q -b feature/unpushed");
    const logs: string[] = [];
    const questions = await runWizard(() => "", logs);

    expect(questions.some((question) => question.startsWith("Base tasks and PRs on"))).toBe(false);
    expect(config().repos[0]?.defaultBranch).toBe("main");
    expect(logs.join("\n")).toContain('"feature/unpushed", but that branch is not on origin');
  });

  test("a re-run offers the saved branch and Enter keeps it", async () => {
    git("checkout -q -b feature/pr-base");
    publishCurrentBranch();
    await runWizard(() => "feature/pr-base");
    expect(config().repos[0]?.defaultBranch).toBe("feature/pr-base");

    const questions = await runWizard(() => "");

    const question = questions.find((candidate) =>
      candidate.startsWith("Base tasks and PRs on feature/pr-base or main?"),
    );
    expect(question).toContain("[feature/pr-base]");
    expect(config().repos[0]?.defaultBranch).toBe("feature/pr-base");
  });

  test("three invalid base-branch answers stop setup without saving", async () => {
    git("checkout -q -b feature/pr-base");
    publishCurrentBranch();
    const questions: string[] = [];
    const output: string[] = [];
    const run = runWorkerInit({
      cwd: repoDir,
      log: (message) => output.push(message),
      prompt: async (question) => {
        questions.push(question);
        if (question.startsWith("Base tasks and PRs on")) return "not-a-branch";
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
    const error = await run.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PromptAttemptsExceededError);
    expect((error as Error).message).toContain("No valid default branch after 3 attempts");
    expect(
      questions.filter((question) => question.startsWith("Base tasks and PRs on")),
    ).toHaveLength(3);
    expect(config().repos[0]?.defaultBranch).toBeUndefined();
  });

  test("a saved branch deleted from origin is replaced on a re-run", async () => {
    git("checkout -q -b feature/pr-base");
    publishCurrentBranch();
    await runWizard(() => "feature/pr-base");
    git("update-ref -d refs/remotes/origin/feature/pr-base");

    const questions = await runWizard(() => "feature/pr-base");

    expect(questions.some((question) => question.startsWith("Base tasks and PRs on"))).toBe(false);
    expect(config().repos[0]?.defaultBranch).toBe("main");
  });

  test("without origin/HEAD the key stays unset instead of guessing the checkout branch", async () => {
    git("checkout -q -b feature/local-only");
    git("symbolic-ref --delete refs/remotes/origin/HEAD");
    const logs: string[] = [];
    const questions = await runWizard(() => "", logs);

    expect(questions.some((question) => question.startsWith("Base tasks and PRs on"))).toBe(false);
    expect(config().repos[0]?.defaultBranch).toBeUndefined();
    expect(logs.join("\n")).toContain("no origin/HEAD");
  });

  test("without origin/HEAD a saved branch missing from origin is cleared", async () => {
    git("checkout -q -b feature/pr-base");
    publishCurrentBranch();
    await runWizard(() => "feature/pr-base");
    expect(config().repos[0]?.defaultBranch).toBe("feature/pr-base");

    git("symbolic-ref --delete refs/remotes/origin/HEAD");
    git("update-ref -d refs/remotes/origin/feature/pr-base");
    const logs: string[] = [];
    await runWizard(() => "", logs);

    expect(config().repos[0]?.defaultBranch).toBeUndefined();
    expect(logs.join("\n")).toContain('Saved default_branch "feature/pr-base" is not on origin');
  });
});
