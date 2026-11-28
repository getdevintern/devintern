/**
 * `devintern init` followed by `devintern worker init` / `worker add-repo`:
 * the manual-only repo init registers becomes a worker repo, the new
 * workspace records the chosen tracker, doctor names a manual-only repo, and
 * the init wizard keeps origin defaults, names the right env file, and lets
 * sign-in be skipped or stopped with a clear message.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { LoginSkippedError } from "@devintern/auth";

import { isPromptAbort, promptInterruptedError } from "../src/lib/cli/prompt-abort";
import { runInitWizard, runTrackerSetup } from "../src/lib/init/wizard";
import { collectWorkerDoctorChecks } from "../src/lib/observability/worker-readiness";
import { loadWorkspaceConfig } from "../src/lib/workspace/config";
import { promoteManualOnlyRepo, runWorkerAddRepo } from "../src/lib/workspace/init";
import { registerManualCheckout } from "../src/lib/workspace/register-checkout";

let root: string;
let checkout: string;
let workspace: string;
let logs: string[];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["DEVINTERN_WORKSPACE_DIR", "TASK_TRACKER", "GITHUB_TOKEN", "GITHUB_REPO"];

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

const log = (message: string) => logs.push(message);
const configPath = () => join(workspace, "workspace.toml");

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), "onboarding-manual-repo-"));
  checkout = join(root, "checkout");
  workspace = join(root, "home");
  process.env.DEVINTERN_WORKSPACE_DIR = workspace;
  mkdirSync(checkout, { recursive: true });
  git(checkout, ["init", "-q"]);
  git(checkout, ["remote", "add", "origin", "git@github.com:acme/notes.git"]);
  logs = [];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("devintern init records the chosen tracker", () => {
  test("a new workspace gets [defaults].tracker from the checkout's env", async () => {
    const result = await registerManualCheckout(checkout, "TASK_TRACKER=github\n", log);
    if (!result.ok) throw new Error(result.error);
    expect(loadWorkspaceConfig(configPath()).defaults.tracker).toBe("github");
  });

  test("an existing workspace keeps its tracker", async () => {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(configPath(), '[defaults]\ntracker = "linear"\n');
    const result = await registerManualCheckout(checkout, "TASK_TRACKER=github\n", log);
    if (!result.ok) throw new Error(result.error);
    expect(loadWorkspaceConfig(configPath()).defaults.tracker).toBe("linear");
  });
});

describe("a manual-only repo becomes a worker repo", () => {
  test("worker add-repo flips manual_only and says so", async () => {
    const registered = await registerManualCheckout(checkout, "TASK_TRACKER=github\n", log);
    if (!registered.ok) throw new Error(registered.error);
    expect(loadWorkspaceConfig(configPath()).repos[0]?.manualOnly).toBe(true);

    expect(await runWorkerAddRepo(checkout, { log, error: log })).toBe(0);
    const repo = loadWorkspaceConfig(configPath()).repos[0];
    expect(repo?.manualOnly).toBeUndefined();
    expect(repo?.envFile).toBe("env/notes.env");
    const all = logs.join("\n");
    expect(all).toContain('"notes" is now picked up by the worker');
    expect(all).toContain("was manual-only, registered by `devintern init`");
    expect(all).not.toContain("config unchanged");
    expect(readFileSync(configPath(), "utf8")).not.toContain("the worker skips this repo");

    // Running it again is a no-op.
    logs = [];
    expect(await runWorkerAddRepo(checkout, { log, error: log })).toBe(0);
    expect(logs.join("\n")).toContain("already in the workspace; config unchanged");
  });

  test("promoteManualOnlyRepo edits only the named entry", () => {
    const text = [
      "[defaults]",
      'tracker = "github"',
      "",
      "[[repos]]",
      'name = "api"',
      'remote = "git@github.com:acme/api.git"',
      "manual_only = true",
      "",
      "[[repos]]",
      'name = "notes"',
      'remote = "git@github.com:acme/notes.git"',
      "# Run by hand from your checkout only; the worker skips this repo.",
      "manual_only = true",
      'env_file = "env/notes.env"',
      "  [repos.env]",
      '  FOO = "bar"',
      "",
    ].join("\n");
    const promoted = promoteManualOnlyRepo(text, "notes");
    expect(promoted).not.toBeNull();
    const repos = loadWorkspaceConfigFromText(promoted!);
    expect(repos.find((repo) => repo.name === "notes")?.manualOnly).toBeUndefined();
    expect(repos.find((repo) => repo.name === "api")?.manualOnly).toBe(true);
    expect(promoted).not.toContain("the worker skips this repo");
    expect(promoteManualOnlyRepo(text, "missing")).toBeNull();
  });

  test("worker doctor names the manual-only repo instead of a dead-end hint", async () => {
    const registered = await registerManualCheckout(checkout, "TASK_TRACKER=github\n", log);
    if (!registered.ok) throw new Error(registered.error);
    const checks = await collectWorkerDoctorChecks({ offline: true }, { processEnv: {} });
    const sources = checks.find((check) => check.id === "work-sources");
    expect(sources?.status).toBe("warn");
    expect(sources?.hint).toContain('"notes" is manual-only (registered by `devintern init`)');
    expect(sources?.hint).toContain("devintern worker add-repo");
  });
});

/** Parse workspace.toml text by writing it to a scratch workspace. */
function loadWorkspaceConfigFromText(text: string) {
  const dir = mkdtempSync(join(root, "parse-"));
  writeFileSync(join(dir, "workspace.toml"), text);
  return loadWorkspaceConfig(join(dir, "workspace.toml")).repos;
}

describe("devintern init wizard", () => {
  const agents = () => [{ name: "claude-code", displayName: "Claude Code" }];

  function queue(answers: string[]) {
    const remaining = [...answers];
    return (question: string): Promise<string> => {
      if (remaining.length === 0) throw new Error(`Prompt queue exhausted at: ${question}`);
      return Promise.resolve(remaining.shift()!);
    };
  }

  test("defaults the repo from origin, keeps it on edit, records the tracker, skips sign-in", async () => {
    const seen: Array<Record<string, string>> = [];
    await runInitWizard({
      prompt: queue([
        "github",
        "ghp_first",
        "", // repo: origin default
        "", // labels
        "e", // edit values after the failed check
        "", // token: keep
        "", // repo: keep
        "", // labels
        "y", // sign in
      ]),
      probe: (_, env) => {
        seen.push({ ...env });
        // A transient failure, not a rejection: a rejected token is not kept.
        return seen.length === 1 ? Promise.reject(new Error("fetch failed")) : Promise.resolve();
      },
      getUser: () => Promise.resolve(null),
      signIn: () => Promise.reject(new LoginSkippedError()),
      listInstalledAgents: agents,
      githubCliToken: () => null,
      cwd: checkout,
      log,
    });
    expect(seen.map((env) => env.GITHUB_REPO)).toEqual(["acme/notes", "acme/notes"]);
    expect(seen[1]?.GITHUB_TOKEN).toBe("ghp_first");
    expect(loadWorkspaceConfig(configPath()).defaults.tracker).toBe("github");
    const all = logs.join("\n");
    expect(all).toContain("Initializing @getdevintern/code");
    expect(all).toContain("Sign-in skipped. Sign in later with `devintern worker login");
    // Setup carries on to the readiness checklist.
    expect(all).toContain("Project initialized successfully");
  });

  test("Ctrl+C during sign-in says what was saved and how to sign in later", async () => {
    const run = runInitWizard({
      prompt: queue(["markdown", "", "", "y"]),
      probe: () => Promise.resolve(),
      getUser: () => Promise.resolve(null),
      signIn: () => Promise.reject(promptInterruptedError()),
      listInstalledAgents: agents,
      githubCliToken: () => null,
      cwd: checkout,
      log,
    });
    const error = await run.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isPromptAbort(error)).toBe(true);
    const all = logs.join("\n");
    expect(all).toContain("Setup stopped at sign-in. Your tracker settings are saved in");
    expect(all).toContain(join(workspace, "env", "notes.env"));
    expect(all).toContain("devintern worker login");
  });

  test("skipping validation names the env file the values went to", async () => {
    const answers = ["github", "ghp_x", "acme/notes", "", "s"];
    await runTrackerSetup(
      () => Promise.resolve(answers.shift() ?? ""),
      log,
      () => Promise.reject(new Error("401")),
      checkout,
      {
        writeEnv: async () => "/somewhere/.env",
        envLabel: "/somewhere/.env",
        githubCliToken: () => null,
      },
    );
    expect(logs.join("\n")).toContain("verify them in /somewhere/.env");
  });
});
