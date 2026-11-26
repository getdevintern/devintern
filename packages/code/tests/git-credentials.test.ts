import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  gitCredentialEnv,
  gitCredentialHelper,
  gitCredentialSources,
  hasConfiguredCredentialHelper,
  isGitNetworkCommand,
  pickGitCredentialEnv,
  redactGitCredentials,
} from "../src/lib/utils/git-credentials";

const TOKEN = "ghp_unitTestToken0123456789abcdefABCDEF";
const noHelper = () => false;

/** Every string a spawned git process could expose outside its environment. */
function configEntries(env: NodeJS.ProcessEnv): Array<[string, string]> {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  return Array.from({ length: count }, (_, index) => [
    env[`GIT_CONFIG_KEY_${index}`] ?? "",
    env[`GIT_CONFIG_VALUE_${index}`] ?? "",
  ]);
}

describe("isGitNetworkCommand", () => {
  test("recognises remote-facing subcommands behind global options", () => {
    expect(isGitNetworkCommand(["clone", "--bare", "https://github.com/a/b.git", "x"])).toBe(true);
    expect(isGitNetworkCommand(["fetch", "--prune", "origin"])).toBe(true);
    expect(isGitNetworkCommand(["push", "origin", "HEAD"])).toBe(true);
    expect(isGitNetworkCommand(["ls-remote", "--heads", "origin"])).toBe(true);
    expect(isGitNetworkCommand(["-C", "/repo", "-c", "a.b=c", "pull", "origin", "main"])).toBe(
      true,
    );
  });

  test("leaves local commands alone", () => {
    expect(isGitNetworkCommand(["status", "--porcelain"])).toBe(false);
    expect(isGitNetworkCommand(["-C", "fetch", "rev-parse", "HEAD"])).toBe(false);
    expect(isGitNetworkCommand([])).toBe(false);
  });
});

describe("gitCredentialSources", () => {
  test("GITHUB_TOKEN covers https://github.com only", () => {
    expect(gitCredentialSources({ GITHUB_TOKEN: TOKEN })).toEqual([
      { url: "https://github.com", username: "x-access-token", tokenVar: "GITHUB_TOKEN" },
    ]);
    expect(gitCredentialSources({ GITHUB_TOKEN: "  " })).toEqual([]);
    expect(gitCredentialSources({})).toEqual([]);
  });

  test("GitLab code-host token is scoped to its instance URL", () => {
    expect(
      gitCredentialSources({
        GITLAB_CODE_HOST_TOKEN: "glpat-x",
        GITLAB_CODE_HOST_URL: "gitlab.example.com/",
      }),
    ).toEqual([
      { url: "https://gitlab.example.com", username: "oauth2", tokenVar: "GITLAB_CODE_HOST_TOKEN" },
    ]);
  });

  test("the GitLab tracker token is reused only for the same instance", () => {
    const tracker = { TASK_TRACKER: "gitlab", GITLAB_TOKEN: "glpat-t" };
    expect(gitCredentialSources(tracker)).toEqual([
      { url: "https://gitlab.com", username: "oauth2", tokenVar: "GITLAB_TOKEN" },
    ]);
    expect(
      gitCredentialSources({ ...tracker, GITLAB_BASE_URL: "https://gitlab.example.com" }),
    ).toEqual([]);
    expect(gitCredentialSources({ GITLAB_TOKEN: "glpat-t" })).toEqual([]);
  });

  test("never targets a plain-HTTP instance", () => {
    expect(
      gitCredentialSources({
        GITLAB_CODE_HOST_TOKEN: "glpat-x",
        GITLAB_CODE_HOST_URL: "http://gitlab.internal",
      }),
    ).toEqual([]);
  });
});

describe("gitCredentialEnv", () => {
  test("HTTPS GitHub token: adds a URL-scoped helper that names the variable, not the token", () => {
    const env = gitCredentialEnv(
      ["fetch", "origin"],
      { GITHUB_TOKEN: TOKEN },
      {
        hasHelper: noHelper,
      },
    );
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    const [[key, value]] = configEntries(env) as [[string, string]];
    expect(key).toBe("credential.https://github.com.helper");
    expect(value).toContain("$GITHUB_TOKEN");
    for (const [name, entry] of Object.entries(env)) {
      if (name !== "GITHUB_TOKEN") expect(entry).not.toContain(TOKEN);
    }
  });

  test("no token: environment is returned unchanged", () => {
    const input = { PATH: "/usr/bin" };
    expect(gitCredentialEnv(["clone", "https://github.com/a/b.git"], input)).toBe(input);
  });

  test("local commands are never touched", () => {
    const input = { GITHUB_TOKEN: TOKEN };
    expect(gitCredentialEnv(["commit", "-m", "x"], input, { hasHelper: noHelper })).toBe(input);
  });

  test("a user's own helper for the host wins", () => {
    const input = { GITHUB_TOKEN: TOKEN };
    expect(gitCredentialEnv(["push"], input, { hasHelper: () => true })).toBe(input);
  });

  test("an explicit GIT_ASKPASS program wins; an empty one does not count", () => {
    const askpass = { GITHUB_TOKEN: TOKEN, GIT_ASKPASS: "/usr/local/bin/askpass" };
    expect(gitCredentialEnv(["push"], askpass, { hasHelper: noHelper })).toBe(askpass);
    const empty = { GITHUB_TOKEN: TOKEN, GIT_ASKPASS: "" };
    expect(gitCredentialEnv(["push"], empty, { hasHelper: noHelper }).GIT_CONFIG_COUNT).toBe("1");
  });

  test("appends after existing GIT_CONFIG entries and skips a malformed count", () => {
    const env = gitCredentialEnv(
      ["push"],
      {
        GITHUB_TOKEN: TOKEN,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/dev/null",
      },
      { hasHelper: noHelper },
    );
    expect(configEntries(env).map(([key]) => key)).toEqual([
      "core.hooksPath",
      "credential.https://github.com.helper",
    ]);
    const bad = { GITHUB_TOKEN: TOKEN, GIT_CONFIG_COUNT: "x" };
    expect(gitCredentialEnv(["push"], bad, { hasHelper: noHelper })).toBe(bad);
  });

  test("the helper refuses unsafe variable names", () => {
    expect(() =>
      gitCredentialHelper({ url: "https://x", username: "u", tokenVar: "A; rm -rf /" }),
    ).toThrow();
  });
});

describe("redaction and env picking", () => {
  test("scrubs supplied token values from git output", () => {
    const out = redactGitCredentials(`fatal: bad ${TOKEN} here`, { GITHUB_TOKEN: TOKEN });
    expect(out).toBe("fatal: bad [redacted] here");
  });

  test("picks only credential-relevant keys", () => {
    expect(pickGitCredentialEnv({ GITHUB_TOKEN: "t", PATH: "/bin", TASK_TRACKER: "jira" })).toEqual(
      { GITHUB_TOKEN: "t", TASK_TRACKER: "jira" },
    );
  });
});

describe("real git", () => {
  let home: string;
  let baseEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "git-credentials-"));
    baseEnv = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GITHUB_TOKEN: TOKEN,
    };
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const fill = (env: NodeJS.ProcessEnv, host = "github.com") =>
    spawnSync("git", ["credential", "fill"], {
      cwd: home,
      env,
      input: `protocol=https\nhost=${host}\npath=acme/repo.git\n\n`,
      encoding: "utf8",
    });

  test("git resolves the token through the helper for github.com", () => {
    const env = gitCredentialEnv(["fetch"], baseEnv, { cwd: home });
    const result = fill(env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("username=x-access-token\n");
    expect(result.stdout).toContain(`password=${TOKEN}\n`);
  });

  test("the helper does not answer for other hosts", () => {
    const env = gitCredentialEnv(["fetch"], baseEnv, { cwd: home });
    const result = fill(env, "example.com");
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain(TOKEN);
  });

  test("a configured helper (even a storing one) is detected and left alone", () => {
    writeFileSync(join(home, ".gitconfig"), "[credential]\n\thelper = store\n");
    expect(hasConfiguredCredentialHelper("https://github.com", baseEnv, home)).toBe(true);
    expect(gitCredentialEnv(["fetch"], baseEnv, { cwd: home })).toBe(baseEnv);
  });

  test("an empty helper (list reset) counts as none", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
    };
    expect(hasConfiguredCredentialHelper("https://github.com", env, home)).toBe(false);
    expect(fill(gitCredentialEnv(["fetch"], env, { cwd: home })).stdout).toContain(TOKEN);
  });
});
