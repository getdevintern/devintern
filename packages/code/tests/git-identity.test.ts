import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { commitImplementation } from "../src/lib/agent/run-harness-finalize";
import type { DeliveryState } from "../src/lib/agent/run-harness-finalize";
import { runContext } from "../src/lib/cli/context";
import { gitCommitIdentityCheck } from "../src/lib/observability/git-identity-readiness";
import { buildWorkerDoctorReport } from "../src/lib/observability/readiness-json";
import { preserveUnfinishedWork } from "../src/lib/task/preserve-work";
import { Utils } from "../src/lib/utils";
import {
  FALLBACK_COMMIT_IDENTITY,
  classifyCommitConfigError,
  commitIdentityEnv,
  parseGitHubUser,
  parseGitLabUser,
  resolveCommitIdentity,
  setCommitIdentityDepsForTests,
} from "../src/lib/utils/git-identity";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import { buildRepoEnv } from "../src/lib/workspace/env";

let root: string;
let home: string;

/** A git environment with no identity anywhere: no global/system config, no env. */
function blankGitEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "missing.gitconfig"),
    GIT_CEILING_DIRECTORIES: root,
    ...extra,
  };
}

function git(cwd: string, args: string[], env = blankGitEnv()): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: env as Record<string, string>,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

const SEED = ["-c", "user.name=Someone Else", "-c", "user.email=someone@example.com"];

/** A repo with one commit by "Someone Else" and no identity configured. */
function makeRepo(name = "repo"): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, ["add", "."]);
  git(dir, [...SEED, "commit", "-qm", "seed"]);
  return dir;
}

/** A fetch that answers `GET /user` like GitHub, counting calls. */
function fakeGitHub(user: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(user), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "git-identity-"));
  home = join(root, "home");
  mkdirSync(home);
  setCommitIdentityDepsForTests({
    cachePath: join(root, "cache.json"),
    remoteUrl: () => undefined,
    fetch: (async () => {
      throw new Error("network disabled in tests");
    }) as unknown as typeof fetch,
    warn: () => {},
  });
});

afterEach(() => {
  setCommitIdentityDepsForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("commitIdentityEnv resolution order", () => {
  test("a configured git identity wins: nothing is supplied", async () => {
    const repo = makeRepo();
    git(repo, ["config", "user.name", "Repo User"]);
    git(repo, ["config", "user.email", "repo@example.com"]);
    const env = blankGitEnv({
      DEVINTERN_GIT_AUTHOR_NAME: "Setting",
      DEVINTERN_GIT_AUTHOR_EMAIL: "setting@example.com",
    });
    expect(await commitIdentityEnv(["commit"], repo, env)).toBeUndefined();
  });

  test("GIT_AUTHOR_*/GIT_COMMITTER_* in the environment win", async () => {
    const repo = makeRepo();
    const env = blankGitEnv({
      GIT_AUTHOR_NAME: "Env",
      GIT_AUTHOR_EMAIL: "env@example.com",
      GIT_COMMITTER_NAME: "Env",
      GIT_COMMITTER_EMAIL: "env@example.com",
      DEVINTERN_GIT_AUTHOR_NAME: "Setting",
      DEVINTERN_GIT_AUTHOR_EMAIL: "setting@example.com",
    });
    expect(await commitIdentityEnv(["commit"], repo, env)).toBeUndefined();
  });

  test("-c user.* on the command line (GitHub App author) counts as configured", async () => {
    const repo = makeRepo();
    const args = ["-c", "user.name=app[bot]", "-c", "user.email=1+app[bot]@x", "commit"];
    expect(await commitIdentityEnv(args, repo, blankGitEnv())).toBeUndefined();
  });

  test("only the missing fields are filled", async () => {
    const repo = makeRepo();
    git(repo, ["config", "user.name", "Only Name"]);
    const env = blankGitEnv({
      DEVINTERN_GIT_AUTHOR_NAME: "Setting",
      DEVINTERN_GIT_AUTHOR_EMAIL: "setting@example.com",
    });
    expect(await commitIdentityEnv(["commit"], repo, env)).toEqual({
      GIT_AUTHOR_EMAIL: "setting@example.com",
      GIT_COMMITTER_EMAIL: "setting@example.com",
    });
  });

  test("the workspace setting comes before the token's user", async () => {
    const repo = makeRepo();
    const { calls, fetchFn } = fakeGitHub({ id: 1, login: "octo" });
    setCommitIdentityDepsForTests({ cachePath: join(root, "c.json"), fetch: fetchFn });
    const env = blankGitEnv({
      GITHUB_TOKEN: "test-token",
      DEVINTERN_GIT_AUTHOR_NAME: "Setting",
      DEVINTERN_GIT_AUTHOR_EMAIL: "setting@example.com",
    });
    expect(await commitIdentityEnv(["commit"], repo, env)).toEqual({
      GIT_AUTHOR_NAME: "Setting",
      GIT_AUTHOR_EMAIL: "setting@example.com",
      GIT_COMMITTER_NAME: "Setting",
      GIT_COMMITTER_EMAIL: "setting@example.com",
    });
    expect(calls).toHaveLength(0);
  });

  test("token mode derives the GitHub user with a noreply email, cached on disk", async () => {
    const repo = makeRepo();
    const cachePath = join(root, "c.json");
    const { calls, fetchFn } = fakeGitHub({ id: 583231, login: "octocat", name: "The Octocat" });
    setCommitIdentityDepsForTests({ cachePath, fetch: fetchFn, remoteUrl: () => undefined });
    const env = blankGitEnv({ GITHUB_TOKEN: "test-token" });
    expect(await commitIdentityEnv(["commit"], repo, env)).toEqual({
      GIT_AUTHOR_NAME: "The Octocat",
      GIT_AUTHOR_EMAIL: "583231+octocat@users.noreply.github.com",
      GIT_COMMITTER_NAME: "The Octocat",
      GIT_COMMITTER_EMAIL: "583231+octocat@users.noreply.github.com",
    });
    expect(calls).toEqual(["https://api.github.com/user"]);

    // A new process (memo cleared) reads the disk cache instead of the API.
    setCommitIdentityDepsForTests({ cachePath, fetch: fetchFn, remoteUrl: () => undefined });
    const again = await resolveCommitIdentity(env);
    expect(again).toMatchObject({ name: "The Octocat", source: "github-user" });
    expect(calls).toHaveLength(1);
  });

  test("falls back to DevIntern with a warning when nothing resolves", async () => {
    const repo = makeRepo();
    const warnings: string[] = [];
    setCommitIdentityDepsForTests({
      cachePath: join(root, "c.json"),
      remoteUrl: () => undefined,
      warn: (message) => warnings.push(message),
    });
    const env = await commitIdentityEnv(["commit"], repo, blankGitEnv());
    expect(env).toEqual({
      GIT_AUTHOR_NAME: FALLBACK_COMMIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: FALLBACK_COMMIT_IDENTITY.email,
      GIT_COMMITTER_NAME: FALLBACK_COMMIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: FALLBACK_COMMIT_IDENTITY.email,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("git config --global user.name");
    expect(warnings[0]).toContain("git_author_name");
  });

  test("a rejected token falls back instead of failing the commit", async () => {
    setCommitIdentityDepsForTests({
      cachePath: join(root, "c.json"),
      remoteUrl: () => undefined,
      fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
      warn: () => {},
    });
    const identity = await resolveCommitIdentity(blankGitEnv({ GITHUB_TOKEN: "bad" }));
    expect(identity.source).toBe("fallback");
    expect(identity.reason).toContain("HTTP 401");
  });

  test("executeGitCommand commits on a blank host with the resolved identity", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, ["add", "a.txt"]);
    const env = blankGitEnv({
      DEVINTERN_GIT_AUTHOR_NAME: "Workspace Bot",
      DEVINTERN_GIT_AUTHOR_EMAIL: "bot@example.com",
    });
    const result = await Utils.executeGitCommand(["commit", "-qm", "x"], { cwd: repo, env });
    expect(result.success).toBe(true);
    expect(git(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(
      "Workspace Bot <bot@example.com>|Workspace Bot <bot@example.com>",
    );
  });
});

describe("user API parsing", () => {
  test("GitHub: name falls back to login", () => {
    expect(parseGitHubUser({ id: 7, login: "bot-user", name: null })).toEqual({
      name: "bot-user",
      email: "7+bot-user@users.noreply.github.com",
    });
    expect(parseGitHubUser({ login: "x" })).toBeUndefined();
  });

  test("GitLab: commit_email, else the instance noreply address", () => {
    expect(parseGitLabUser({ id: 3, username: "dev", name: "Dev" }, "gitlab.example.com")).toEqual({
      name: "Dev",
      email: "3-dev@users.noreply.gitlab.example.com",
    });
    expect(
      parseGitLabUser({ id: 3, username: "dev", commit_email: "dev@corp.example" }, "gitlab.com"),
    ).toEqual({ name: "dev", email: "dev@corp.example" });
  });
});

describe("commit error classification", () => {
  test.each([
    "Author identity unknown\n\n*** Please tell me who you are.",
    "fatal: empty ident name (for <tester@box>) not allowed",
    "fatal: unable to auto-detect email address (got 'tester@abc123.(none)')",
    "error: gpg failed to sign the data\nfatal: failed to write commit object",
  ])("%p is a configuration error", (output) => {
    expect(classifyCommitConfigError(output)).toBeTruthy();
  });

  test("hook and lint failures are not", () => {
    expect(classifyCommitConfigError("husky - pre-commit hook exited with code 1")).toBeUndefined();
    expect(classifyCommitConfigError("eslint: 3 problems")).toBeUndefined();
  });

  test("an identity error fails fast without the hook-fixing agent", async () => {
    const savedCommit = Utils.commitChanges;
    const savedOptions = runContext.options;
    let commits = 0;
    Utils.commitChanges = async () => {
      commits++;
      return {
        success: false,
        message: "Failed to commit changes: git has no commit identity",
        configError: "git has no commit identity on this host (Author identity unknown). To fix, …",
      };
    };
    runContext.options = { verbose: false } as typeof runContext.options;
    // Any use of the harness (the hook-fixing agent) throws.
    const harness = new Proxy(
      {},
      {
        get() {
          throw new Error("hook-fixing agent must not run");
        },
      },
    );
    const state = {
      context: {
        enableGit: true,
        taskKey: "T-1",
        taskSummary: "t",
        hookRetries: 3,
        harness,
        prTargetBranch: "origin/main",
      },
      output: "",
    } as unknown as DeliveryState;
    try {
      expect(await commitImplementation(state)).toBe(false);
      expect(commits).toBe(1);
      expect(state.commitConfigError).toContain("Author identity unknown");
    } finally {
      Utils.commitChanges = savedCommit;
      runContext.options = savedOptions;
    }
  });

  test("commitChanges reports a signing failure as configError, not hookError", async () => {
    const repo = makeRepo();
    git(repo, ["checkout", "-qb", "feature/x"]);
    git(repo, ["config", "user.name", "Repo User"]);
    git(repo, ["config", "user.email", "repo@example.com"]);
    git(repo, ["config", "commit.gpgsign", "true"]);
    git(repo, ["config", "gpg.program", "false"]);
    writeFileSync(join(repo, "b.txt"), "b\n");
    // The repo-local config decides: identity set, signing broken.
    const result = await Utils.commitChanges("T-1", "t", { cwd: repo });
    expect(result.success).toBe(false);
    expect(result.hookError).toBeUndefined();
    expect(result.configError).toContain("commit signing");
  });
});

describe("preserveUnfinishedWork identity", () => {
  test("the WIP commit never borrows HEAD's identity", async () => {
    const remote = join(root, "remote.git");
    git(root, ["init", "-q", "--bare", "-b", "main", remote]);
    const repo = makeRepo("work");
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-q", "origin", "main"]);
    git(repo, ["checkout", "-qb", "feature/t-1"]);
    writeFileSync(join(repo, "wip.txt"), "half done\n");

    const env = blankGitEnv({ GITHUB_TOKEN: "" });
    const preserved = await preserveUnfinishedWork({
      taskKey: "T-1",
      cwd: repo,
      git: (args, extra) => Utils.executeGitCommand(args, { cwd: repo, env: { ...env, ...extra } }),
    });
    expect(preserved.kind).toBe("pushed");
    const author = git(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]);
    expect(author).not.toContain("someone@example.com");
    expect(author).toBe(
      `${FALLBACK_COMMIT_IDENTITY.name} <${FALLBACK_COMMIT_IDENTITY.email}>|` +
        `${FALLBACK_COMMIT_IDENTITY.name} <${FALLBACK_COMMIT_IDENTITY.email}>`,
    );
  });
});

describe("workspace git_author settings", () => {
  const base = `
[defaults]
tracker = "markdown"
task_query = "status=todo"
`;

  test("[workspace] applies to every repo and a repo entry overrides it", () => {
    const config = parseWorkspaceConfig(`${base}
[workspace]
git_author_name = "Fleet Bot"
git_author_email = "fleet@example.com"

[[repos]]
name = "a"
remote = "https://github.com/acme/a.git"

[[repos]]
name = "b"
remote = "https://github.com/acme/b.git"
git_author_name = "B Bot"
git_author_email = "b@example.com"
`);
    expect(config.repos.map((repo) => repo.gitAuthor)).toEqual([
      { name: "Fleet Bot", email: "fleet@example.com" },
      { name: "B Bot", email: "b@example.com" },
    ]);
    const env = buildRepoEnv(config.repos[0]!, root);
    expect(env.DEVINTERN_GIT_AUTHOR_NAME).toBe("Fleet Bot");
    expect(env.DEVINTERN_GIT_AUTHOR_EMAIL).toBe("fleet@example.com");
  });

  test("a name without an email is rejected", () => {
    expect(() =>
      parseWorkspaceConfig(`${base}
[workspace]
git_author_name = "Fleet Bot"

[[repos]]
name = "a"
remote = "https://github.com/acme/a.git"
`),
    ).toThrow("set both git_author_name and git_author_email");
  });
});

describe("Git commit identity readiness", () => {
  test("configured git identity passes", async () => {
    const check = await gitCommitIdentityCheck({
      workspaceDir: root,
      processEnv: blankGitEnv({
        GIT_AUTHOR_NAME: "Op",
        GIT_AUTHOR_EMAIL: "op@example.com",
        GIT_COMMITTER_NAME: "Op",
        GIT_COMMITTER_EMAIL: "op@example.com",
      }),
      offline: true,
    });
    expect(check).toMatchObject({ id: "git-identity", status: "ok" });
    expect(check.detail).toContain("configured in git");
  });

  test("token user passes with its source", async () => {
    const { fetchFn } = fakeGitHub({ id: 9, login: "worker-bot" });
    const check = await gitCommitIdentityCheck({
      workspaceDir: root,
      processEnv: blankGitEnv({ GITHUB_TOKEN: "test-token" }),
      offline: false,
      deps: { fetch: fetchFn, cachePath: join(root, "doctor.json") },
    });
    expect(check.status).toBe("ok");
    expect(check.detail).toBe(
      "worker-bot <9+worker-bot@users.noreply.github.com> (derived from the GitHub token's user)",
    );
  });

  test("fallback warns with the fix", async () => {
    const check = await gitCommitIdentityCheck({
      workspaceDir: root,
      processEnv: blankGitEnv(),
      offline: false,
    });
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("(fallback)");
    expect(check.hint).toContain("git config --global user.email");

    // `worker doctor --json`: a warning in the shared check shape, still success.
    const report = buildWorkerDoctorReport([check], {
      workspaceDir: root,
      offline: false,
      env: {},
      home,
    });
    expect(report.result).toBe("success");
    expect(report.checks).toEqual([
      {
        name: "git-identity",
        label: "Git commit identity",
        status: "warn",
        message: expect.stringContaining("DevIntern <devintern@users.noreply.github.com>"),
        hint: expect.stringContaining("git_author_email"),
      },
    ]);
  });
});
