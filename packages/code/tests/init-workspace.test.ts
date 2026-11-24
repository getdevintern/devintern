import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runInitUpgrade, runInitWizard } from "../src/lib/init/wizard";
import { loadWorkspaceConfig } from "../src/lib/workspace/config";
import { workerWorkspaceView } from "../src/lib/workspace/manual-only";
import { registerManualCheckout } from "../src/lib/workspace/register-checkout";

let root: string;
let checkout: string;
let workspace: string;
const savedWorkspace = process.env.DEVINTERN_WORKSPACE_DIR;

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function promptQueue(answers: string[]) {
  const remaining = [...answers];
  return (question: string): Promise<string> => {
    if (remaining.length === 0) throw new Error(`Prompt queue exhausted at: ${question}`);
    return Promise.resolve(remaining.shift()!);
  };
}

const silentLog = () => {};
const deps = {
  getUser: () => Promise.resolve(null),
  listInstalledAgents: () => [{ name: "claude-code", displayName: "Claude Code" }],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "init-workspace-"));
  checkout = join(root, "checkout");
  workspace = join(root, "home");
  process.env.DEVINTERN_WORKSPACE_DIR = workspace;
  spawnSync("mkdir", ["-p", checkout]);
  git(checkout, ["init", "-q"]);
  git(checkout, ["remote", "add", "origin", "git@github.com:acme/notes.git"]);
});

afterEach(() => {
  if (savedWorkspace === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
  else process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspace;
  rmSync(root, { recursive: true, force: true });
});

describe("registerManualCheckout", () => {
  test("creates the workspace and a manual-only repo with its own env file", async () => {
    const result = await registerManualCheckout(checkout, "TASK_TRACKER=linear\n", silentLog);
    if (!result.ok) throw new Error(result.error);
    expect(result.created).toBe(true);
    expect(result.repoName).toBe("notes");
    expect(result.envPath).toBe(join(workspace, "env", "notes.env"));
    expect(readFileSync(result.envPath, "utf8")).toBe("TASK_TRACKER=linear\n");
    expect(statSync(result.envPath).mode & 0o777).toBe(0o600);

    const config = loadWorkspaceConfig(join(workspace, "workspace.toml"));
    const repo = config.repos.find((entry) => entry.name === "notes");
    expect(repo?.manualOnly).toBe(true);
    expect(repo?.envFile).toBe("env/notes.env");
    expect(workerWorkspaceView(config).repos).toHaveLength(0);
    expect(existsSync(join(checkout, ".devintern-code"))).toBe(false);
  });

  test("refuses a checkout that is already registered", async () => {
    await registerManualCheckout(checkout, "", silentLog);
    const again = await registerManualCheckout(checkout, "", silentLog);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("already registered");
  });

  test("registers a checkout without a recognised remote by its directory", async () => {
    git(checkout, ["remote", "remove", "origin"]);
    const result = await registerManualCheckout(checkout, "", silentLog);
    if (!result.ok) throw new Error(result.error);
    const repo = loadWorkspaceConfig(join(workspace, "workspace.toml")).repos[0];
    expect(repo?.path).toBe(checkout);
    expect(repo?.remote).toBe("");
    expect((await registerManualCheckout(join(checkout), "", silentLog)).ok).toBe(false);
  });
});

describe("init wizard in a checkout with an origin", () => {
  test("writes nothing into the checkout and registers it in the workspace", async () => {
    await runInitWizard({
      ...deps,
      prompt: promptQueue(["markdown", "", "", "n"]),
      probe: () => Promise.resolve(),
      cwd: checkout,
      log: silentLog,
    });
    expect(existsSync(join(checkout, ".devintern-code"))).toBe(false);
    expect(existsSync(join(checkout, ".gitignore"))).toBe(false);
    const env = readFileSync(join(workspace, "env", "notes.env"), "utf8");
    expect(env).toContain("TASK_TRACKER=markdown");
  });

  test("an upgrade edits the given env file", async () => {
    const result = await registerManualCheckout(
      checkout,
      "TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=./tasks\n",
      silentLog,
    );
    if (!result.ok) throw new Error(result.error);
    await runInitUpgrade({
      ...deps,
      envPath: result.envPath,
      prompt: promptQueue(["1", "./todo", ""]),
      probe: () => Promise.resolve(),
      cwd: checkout,
      log: silentLog,
    });
    expect(readFileSync(result.envPath, "utf8")).toContain("MARKDOWN_TASKS_DIR=./todo");
    expect(existsSync(join(checkout, ".devintern-code"))).toBe(false);
  });
});
