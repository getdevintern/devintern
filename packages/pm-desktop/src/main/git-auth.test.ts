import { describe, expect, test } from "bun:test";
import { appendGitConfigEnv, isGitHubHttpsRemote, withGitHubTokenAuth } from "./git-auth.ts";
import { withSyncBudget, type GitExec, type GitExecOptions } from "./git-sync.ts";

describe("isGitHubHttpsRemote", () => {
  test("accepts github.com HTTPS", () => {
    expect(isGitHubHttpsRemote("https://github.com/acme/web.git")).toBe(true);
    expect(isGitHubHttpsRemote("https://www.github.com/acme/web")).toBe(true);
  });

  test("rejects SSH, HTTP, and non-GitHub hosts", () => {
    expect(isGitHubHttpsRemote("git@github.com:acme/web.git")).toBe(false);
    expect(isGitHubHttpsRemote("http://github.com/acme/web.git")).toBe(false);
    expect(isGitHubHttpsRemote("https://gitlab.com/acme/web.git")).toBe(false);
    expect(isGitHubHttpsRemote("https://github.example.com/acme/web.git")).toBe(false);
  });
});

describe("appendGitConfigEnv", () => {
  test("appends at the next index without clobbering existing entries", () => {
    const env = appendGitConfigEnv(
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.proxy",
        GIT_CONFIG_VALUE_0: "http://proxy.example",
      },
      "http.https://github.com/.extraHeader",
      "Authorization: Bearer secret",
    );
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.proxy");
    expect(env.GIT_CONFIG_VALUE_0).toBe("http://proxy.example");
    expect(env.GIT_CONFIG_KEY_1).toBe("http.https://github.com/.extraHeader");
    expect(env.GIT_CONFIG_VALUE_1).toBe("Authorization: Bearer secret");
  });
});

describe("withGitHubTokenAuth", () => {
  test("injects Bearer via URL-scoped GIT_CONFIG env for GitHub HTTPS network commands", async () => {
    const calls: { args: string[]; options?: GitExecOptions }[] = [];
    const inner: GitExec = async (_cwd, args, options) => {
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "https://github.com/acme/web.git\n", stderr: "" };
      }
      calls.push({ args: [...args], options });
      return { code: 0, stdout: "", stderr: "" };
    };
    const git = withGitHubTokenAuth(inner, async () => "secret-token");
    await git("/tmp", ["fetch", "origin"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["fetch", "origin"]);
    expect(calls[0]?.options?.env?.GIT_CONFIG_COUNT).toBe("1");
    expect(calls[0]?.options?.env?.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
    expect(calls[0]?.options?.env?.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer secret-token");
    // PAT must not appear on argv.
    expect(calls[0]?.args.join(" ")).not.toContain("secret-token");
  });

  test("scopes www.github.com remotes to that host", async () => {
    const calls: { args: string[]; options?: GitExecOptions }[] = [];
    const inner: GitExec = async (_cwd, args, options) => {
      calls.push({ args: [...args], options });
      return { code: 0, stdout: "", stderr: "" };
    };
    const git = withGitHubTokenAuth(inner, async () => "secret-token");
    await git("/tmp", ["clone", "https://www.github.com/acme/web.git", "."]);
    expect(calls[0]?.options?.env?.GIT_CONFIG_KEY_0).toBe(
      "http.https://www.github.com/.extraHeader",
    );
  });

  test("composes with pre-existing GIT_CONFIG_* env entries", async () => {
    const calls: { args: string[]; options?: GitExecOptions }[] = [];
    const inner: GitExec = async (_cwd, args, options) => {
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "https://github.com/acme/web.git\n", stderr: "" };
      }
      calls.push({ args: [...args], options });
      return { code: 0, stdout: "", stderr: "" };
    };
    const git = withGitHubTokenAuth(inner, async () => "secret-token");
    await git("/tmp", ["fetch", "origin"], {
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.version",
        GIT_CONFIG_VALUE_0: "HTTP/1.1",
      },
    });
    expect(calls[0]?.options?.env?.GIT_CONFIG_COUNT).toBe("2");
    expect(calls[0]?.options?.env?.GIT_CONFIG_KEY_0).toBe("http.version");
    expect(calls[0]?.options?.env?.GIT_CONFIG_KEY_1).toBe("http.https://github.com/.extraHeader");
    expect(calls[0]?.options?.env?.GIT_CONFIG_VALUE_1).toBe("Authorization: Bearer secret-token");
  });

  test("injects from clone URL in args without remote lookup", async () => {
    const calls: { args: string[]; options?: GitExecOptions }[] = [];
    const inner: GitExec = async (_cwd, args, options) => {
      calls.push({ args: [...args], options });
      return { code: 0, stdout: "", stderr: "" };
    };
    const git = withGitHubTokenAuth(inner, async () => "secret-token");
    await git("/tmp", ["clone", "https://github.com/acme/web.git", "."]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.env?.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
    expect(calls[0]?.options?.env?.GIT_CONFIG_VALUE_0).toContain("Bearer secret-token");
    expect(calls[0]?.args).toEqual(["clone", "https://github.com/acme/web.git", "."]);
  });

  test("does not inject for non-GitHub remotes", async () => {
    const calls: { args: string[]; options?: GitExecOptions }[] = [];
    const inner: GitExec = async (_cwd, args, options) => {
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "https://gitlab.com/acme/web.git\n", stderr: "" };
      }
      calls.push({ args: [...args], options });
      return { code: 0, stdout: "", stderr: "" };
    };
    const git = withGitHubTokenAuth(inner, async () => "secret-token");
    await git("/tmp", ["fetch", "origin"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["fetch", "origin"]);
    expect(calls[0]?.options?.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  test("does not inject for GitHub SSH remotes", async () => {
    const calls: { args: string[]; options?: GitExecOptions }[] = [];
    const inner: GitExec = async (_cwd, args, options) => {
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "git@github.com:acme/web.git\n", stderr: "" };
      }
      calls.push({ args: [...args], options });
      return { code: 0, stdout: "", stderr: "" };
    };
    const git = withGitHubTokenAuth(inner, async () => "secret-token");
    await git("/tmp", ["fetch", "origin"]);
    expect(calls[0]?.options?.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  test("does not inject for status", async () => {
    const calls: string[][] = [];
    const inner: GitExec = async (_cwd, args) => {
      calls.push([...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const git = withGitHubTokenAuth(inner, async () => "secret-token");
    await git("/tmp", ["status", "--porcelain"]);
    expect(calls[0]).toEqual(["status", "--porcelain"]);
  });

  test("skips inject when no token", async () => {
    const calls: { args: string[]; options?: GitExecOptions }[] = [];
    const inner: GitExec = async (_cwd, args, options) => {
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "https://github.com/acme/web.git\n", stderr: "" };
      }
      calls.push({ args: [...args], options });
      return { code: 0, stdout: "", stderr: "" };
    };
    const git = withGitHubTokenAuth(inner, async () => null);
    await git("/tmp", ["fetch", "origin"]);
    expect(calls[0]?.args).toEqual(["fetch", "origin"]);
    expect(calls[0]?.options?.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  test("sync budget still shrinks timeouts through the auth wrapper", async () => {
    const timeouts: number[] = [];
    const inner: GitExec = async (_cwd, _args, options) => {
      timeouts.push(options?.timeoutMs ?? -1);
      return { code: 0, stdout: "", stderr: "" };
    };
    const git = withSyncBudget(
      withGitHubTokenAuth(inner, async () => null),
      10_000,
    );
    await git("/tmp", ["status"]);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(10_000);
  });
});
