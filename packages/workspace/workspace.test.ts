import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findWorkspaceRepo,
  matchWorkspaceRepo,
  normalizeRemote,
  parseEnvText,
  parseWorkspaceFile,
  readWorkspaceFile,
  repoCredentialEnv,
  resolveWorkspaceDir,
} from "./src/index.ts";
import type { WorkspaceRepo } from "./src/index.ts";

let root: string;
let workspaceDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "devintern-workspace-"));
  workspaceDir = join(root, "home");
  mkdirSync(workspaceDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function repo(overrides: Partial<WorkspaceRepo>): WorkspaceRepo {
  return { name: "r", env: {}, manualOnly: false, ...overrides };
}

describe("resolveWorkspaceDir", () => {
  test("DEVINTERN_WORKSPACE_DIR wins, trimmed", () => {
    expect(resolveWorkspaceDir({ DEVINTERN_WORKSPACE_DIR: " /tmp/ws " })).toBe("/tmp/ws");
  });

  test("defaults to ~/.devintern", () => {
    expect(resolveWorkspaceDir({})).toEndWith("/.devintern");
  });
});

describe("normalizeRemote", () => {
  test("ssh, scp-like and https forms of one repo compare equal", () => {
    const forms = [
      "git@github.com:Acme/API.git",
      "https://github.com/acme/api",
      "https://token@github.com/acme/api.git/",
      "ssh://git@github.com:22/acme/api.git",
    ];
    expect(new Set(forms.map(normalizeRemote))).toEqual(new Set(["github.com/acme/api"]));
  });

  test("non-GitHub paths keep their case", () => {
    expect(normalizeRemote("git@gitlab.example.com:Group/Sub/Repo.git")).toBe(
      "gitlab.example.com/Group/Sub/Repo",
    );
  });

  test("local paths are not remotes", () => {
    expect(normalizeRemote("/srv/git/repo.git")).toBeNull();
    expect(normalizeRemote("file:///srv/git/repo.git")).toBeNull();
    expect(normalizeRemote("../repo")).toBeNull();
  });
});

describe("parseWorkspaceFile", () => {
  test("reads repos leniently and the default tracker", () => {
    const file = parseWorkspaceFile(`
[defaults]
tracker = "jira"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
env_file = "env/api.env"
manual_only = true
[repos.env]
JIRA_PROJECT_KEY = "API"
NUMBER = 3

[[repos]]
remote = "nameless"

[[repos]]
name = "local"
path = "relative/is/ignored"
`);
    expect(file.defaultTracker).toBe("jira");
    expect(file.teams).toEqual([]);
    expect(file.repos).toEqual([
      {
        name: "api",
        remote: "git@github.com:acme/api.git",
        path: undefined,
        envFile: "env/api.env",
        env: { JIRA_PROJECT_KEY: "API" },
        manualOnly: true,
      },
      {
        name: "local",
        remote: undefined,
        path: undefined,
        envFile: undefined,
        env: {},
        manualOnly: false,
      },
    ]);
  });

  test("invalid TOML reads as no workspace", () => {
    writeFileSync(join(workspaceDir, "workspace.toml"), "[[repos]\nname = ");
    expect(readWorkspaceFile(workspaceDir)).toBeNull();
  });
});

describe("matchWorkspaceRepo", () => {
  test("origin match wins over a containing path entry", () => {
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    const byPath = repo({ name: "by-path", path: checkout });
    const byRemote = repo({ name: "by-remote", remote: "https://github.com/acme/api" });
    expect(
      matchWorkspaceRepo([byPath, byRemote], {
        origin: "git@github.com:acme/api.git",
        dir: checkout,
      })?.name,
    ).toBe("by-remote");
  });

  test("the deepest containing path entry wins, through symlinks", () => {
    const outer = join(root, "outer");
    const inner = join(outer, "inner");
    mkdirSync(join(inner, "src"), { recursive: true });
    symlinkSync(outer, join(root, "link"));
    const repos = [repo({ name: "outer", path: outer }), repo({ name: "inner", path: inner })];
    expect(
      matchWorkspaceRepo(repos, { origin: null, dir: join(root, "link", "inner", "src") })?.name,
    ).toBe("inner");
    expect(matchWorkspaceRepo(repos, { origin: null, dir: `${outer}-sibling` })).toBeNull();
  });
});

describe("repoCredentialEnv", () => {
  test("shared .env < env_file < [repos.env]", () => {
    writeFileSync(join(workspaceDir, ".env"), "A=shared\nB=shared\nC=shared\n");
    mkdirSync(join(workspaceDir, "env"));
    writeFileSync(join(workspaceDir, "env", "api.env"), "B=file\nC='file'\n");
    expect(
      repoCredentialEnv({ envFile: "env/api.env", env: { C: "inline" } }, workspaceDir),
    ).toEqual({ A: "shared", B: "file", C: "inline" });
  });

  test("parseEnvText strips quotes and keeps = in values", () => {
    expect(parseEnvText('# c\nA="x=y"\nBAD\n')).toEqual({ A: "x=y" });
  });

  test("parseEnvText accepts a shell export prefix", () => {
    expect(parseEnvText("export A=1\n  export   B='two'\n")).toEqual({ A: "1", B: "two" });
  });

  test("reads every layer through a caller-supplied reader", () => {
    const read: string[] = [];
    const env = repoCredentialEnv({ envFile: "env/api.env", env: {} }, workspaceDir, (path) => {
      read.push(path);
      return { FROM: path };
    });
    expect(read.toSorted()).toEqual([
      join(workspaceDir, ".env"),
      join(workspaceDir, "env", "api.env"),
    ]);
    expect(env).toEqual({ FROM: join(workspaceDir, "env", "api.env") });
  });
});

describe("findWorkspaceRepo", () => {
  test("resolves a git checkout by origin and fills the default tracker", async () => {
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    execFileSync("git", ["init", "-q", checkout]);
    execFileSync("git", ["-C", checkout, "remote", "add", "origin", "git@github.com:acme/api.git"]);
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]\ntracker = "linear"\n\n[[repos]]\nname = "api"\nremote = "https://github.com/acme/api"\n`,
    );
    writeFileSync(join(workspaceDir, ".env"), "LINEAR_API_KEY=lin\n");

    const match = await findWorkspaceRepo({ dir: checkout, workspaceDir });
    expect(match?.repo.name).toBe("api");
    expect(match?.env).toEqual({ LINEAR_API_KEY: "lin", TASK_TRACKER: "linear" });
  });

  test("an env TASK_TRACKER beats [defaults].tracker", async () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]\ntracker = "linear"\n\n[[repos]]\nname = "plain"\npath = ${JSON.stringify(dir)}\nmanual_only = true\n[repos.env]\nTASK_TRACKER = "github"\n`,
    );
    const match = await findWorkspaceRepo({ dir, workspaceDir, origin: null });
    expect(match?.env.TASK_TRACKER).toBe("github");
  });

  test("no workspace.toml or no matching entry is null", async () => {
    expect(await findWorkspaceRepo({ dir: root, workspaceDir, origin: null })).toBeNull();
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[[repos]]\nname = "x"\nremote = "git@github.com:a/b.git"\n`,
    );
    expect(await findWorkspaceRepo({ dir: root, workspaceDir, origin: null })).toBeNull();
  });
});

describe("findWorkspaceRepo team credentials", () => {
  const dir = () => join(root, "app");

  function writeWorkspace(teams: string): void {
    mkdirSync(dir(), { recursive: true });
    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]\ntracker = "linear"\n\n[[repos]]\nname = "app"\npath = ${JSON.stringify(dir())}\nmanual_only = true\n[repos.env]\nREPO_ONLY = "repo"\nSHARED = "repo"\n\n${teams}`,
    );
    writeFileSync(
      join(workspaceDir, ".env"),
      "LINEAR_API_KEY=workspace\nJIRA_PLATFORM_API_TOKEN=ns-token\nJIRA_PLATFORM_URL=https://ns.atlassian.net\n",
    );
    writeFileSync(
      join(workspaceDir, "env", "platform.env"),
      "JIRA_EMAIL=file@x.com\nSHARED=file\n",
    );
  }

  test("no team leaves the repo-level offer", async () => {
    writeWorkspace("");
    const match = await findWorkspaceRepo({ dir: dir(), workspaceDir, origin: null });
    expect(match?.team).toBeUndefined();
    expect(match?.env).toEqual({
      LINEAR_API_KEY: "workspace",
      JIRA_PLATFORM_API_TOKEN: "ns-token",
      JIRA_PLATFORM_URL: "https://ns.atlassian.net",
      REPO_ONLY: "repo",
      SHARED: "repo",
      TASK_TRACKER: "linear",
    });
  });

  test("the one team fixed to the repo layers namespaced, file and inline values", async () => {
    writeWorkspace(
      `[[teams]]\nname = "platform"\ntracker = "jira"\nrepo = "app"\nenv_file = "env/platform.env"\n[teams.env]\nJIRA_DEFAULT_PROJECT_KEY = "PLAT"\n\n[[teams]]\nname = "roaming"\ntracker = "github"\n[teams.env]\nGITHUB_TOKEN = "not-this-one"\n`,
    );
    const match = await findWorkspaceRepo({ dir: dir(), workspaceDir, origin: null });
    expect(match?.team?.name).toBe("platform");
    expect(match?.env).toMatchObject({
      TASK_TRACKER: "jira",
      JIRA_API_TOKEN: "ns-token",
      JIRA_BASE_URL: "https://ns.atlassian.net",
      JIRA_URL: "https://ns.atlassian.net",
      JIRA_EMAIL: "file@x.com",
      JIRA_DEFAULT_PROJECT_KEY: "PLAT",
      SHARED: "file",
      REPO_ONLY: "repo",
    });
    expect(match?.env.GITHUB_TOKEN).toBeUndefined();
  });

  test("a team without its own tracker uses [defaults].tracker", async () => {
    writeWorkspace(
      `[[teams]]\nname = "core"\nrepo = "app"\n[teams.env]\nLINEAR_API_KEY = "team"\n`,
    );
    const match = await findWorkspaceRepo({ dir: dir(), workspaceDir, origin: null });
    expect(match?.env.TASK_TRACKER).toBe("linear");
    expect(match?.env.LINEAR_API_KEY).toBe("team");
  });

  test("several teams fixed to the repo offer nothing from teams", async () => {
    writeWorkspace(
      `[[teams]]\nname = "platform"\ntracker = "jira"\nrepo = "app"\nenv_file = "env/platform.env"\n\n[[teams]]\nname = "mobile"\ntracker = "github"\nrepo = "app"\n[teams.env]\nGITHUB_TOKEN = "team"\n`,
    );
    const match = await findWorkspaceRepo({ dir: dir(), workspaceDir, origin: null });
    expect(match?.team).toBeUndefined();
    expect(match?.env.TASK_TRACKER).toBe("linear");
    expect(match?.env.SHARED).toBe("repo");
    expect(match?.env.GITHUB_TOKEN).toBeUndefined();
    expect(match?.env.JIRA_API_TOKEN).toBeUndefined();
    expect(match?.env.JIRA_EMAIL).toBeUndefined();
  });
});
