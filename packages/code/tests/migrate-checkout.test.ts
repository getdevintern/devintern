import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { WORKER_SUBPROCESS_ENV } from "../src/lib/config/config-dir";
import { loadWorkspaceConfig, parseWorkspaceConfig } from "../src/lib/workspace/config";
import {
  migrateCommittedTrackerSettings,
  migrateLegacyCheckout,
  moveLegacyCheckoutState,
} from "../src/lib/workspace/migrate-checkout";
import {
  appendTrackerSettings,
  loadWorkspaceTrackerSettings,
} from "../src/lib/workspace/tracker-settings";

let root: string;
let checkout: string;
let workspace: string;
const saved = {
  workspace: process.env.DEVINTERN_WORKSPACE_DIR,
  worker: process.env[WORKER_SUBPROCESS_ENV],
};
const silent = () => {};

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

const SETTINGS = {
  projects: { LEG: { prStatus: "Legacy Review" } },
  jira: { projects: { DEV: { inProgressStatus: "In Progress", prStatus: "In Review" } } },
  github: { projects: { "acme/web": { prStatus: "in review" } } },
  pipeline: { steps: [{ use: "implement" }] },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "migrate-checkout-"));
  checkout = join(root, "checkout");
  workspace = join(root, "home");
  process.env.DEVINTERN_WORKSPACE_DIR = workspace;
  delete process.env[WORKER_SUBPROCESS_ENV];
  mkdirSync(join(checkout, ".devintern-code"), { recursive: true });
  git(checkout, ["init", "-q"]);
  git(checkout, ["remote", "add", "origin", "git@github.com:acme/web.git"]);
  writeFileSync(join(checkout, ".devintern-code", ".env"), "TASK_TRACKER=jira\nJIRA_API_TOKEN=t\n");
  writeFileSync(join(checkout, ".devintern-code", "settings.json"), JSON.stringify(SETTINGS));
  writeFileSync(join(checkout, ".devintern-code", ".auth-session.json"), "{}");
  writeFileSync(join(checkout, ".devintern-code", "queue.db"), "history");
});

afterEach(() => {
  if (saved.workspace === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
  else process.env.DEVINTERN_WORKSPACE_DIR = saved.workspace;
  if (saved.worker === undefined) delete process.env[WORKER_SUBPROCESS_ENV];
  else process.env[WORKER_SUBPROCESS_ENV] = saved.worker;
  rmSync(root, { recursive: true, force: true });
});

describe("migrateLegacyCheckout", () => {
  test("registers the checkout and moves its local settings, once", async () => {
    const result = await migrateLegacyCheckout(join(checkout), silent);
    if (!result.migrated) throw new Error("expected a migration");
    expect(result.repoName).toBe("web");

    const legacy = join(checkout, ".devintern-code");
    expect(readFileSync(result.envPath, "utf8")).toContain("JIRA_API_TOKEN=t");
    expect(existsSync(join(legacy, ".env"))).toBe(false);
    expect(existsSync(join(legacy, ".auth-session.json"))).toBe(false);
    expect(existsSync(join(workspace, "state", "code", ".auth-session.json"))).toBe(true);
    // Committed config and run history stay where they are.
    expect(existsSync(join(legacy, "settings.json"))).toBe(true);
    expect(readFileSync(join(legacy, "queue.db"), "utf8")).toBe("history");

    const config = loadWorkspaceConfig(join(workspace, "workspace.toml"));
    expect(config.repos.find((repo) => repo.name === "web")?.manualOnly).toBe(true);
    expect(config.trackerSettings?.jira?.projects?.DEV?.prStatus).toBe("In Review");
    expect(config.trackerSettings?.jira?.projects?.LEG?.prStatus).toBe("Legacy Review");
    expect(config.trackerSettings?.github?.projects?.["acme/web"]?.prStatus).toBe("in review");
    expect(result.trackers.sort()).toEqual(["github/acme/web", "jira/DEV", "jira/LEG"]);

    expect((await migrateLegacyCheckout(checkout, silent)).migrated).toBe(false);
  });

  test("does not register worker subprocesses or checkouts with neither a .env nor tracker settings", async () => {
    process.env[WORKER_SUBPROCESS_ENV] = "1";
    expect((await migrateLegacyCheckout(checkout, silent)).migrated).toBe(false);
    delete process.env[WORKER_SUBPROCESS_ENV];

    rmSync(join(checkout, ".devintern-code", ".env"));
    rmSync(join(checkout, ".devintern-code", "settings.json"));
    expect((await migrateLegacyCheckout(checkout, silent)).migrated).toBe(false);
    // Nothing is registered, but the sign-in still moves to the workspace.
    expect(existsSync(join(workspace, "workspace.toml"))).toBe(false);
    expect(existsSync(join(workspace, "state", "code", ".auth-session.json"))).toBe(true);
    expect(existsSync(join(checkout, ".devintern-code", ".auth-session.json"))).toBe(false);
  });

  test("committed tracker settings alone register the checkout with an empty env", async () => {
    rmSync(join(checkout, ".devintern-code", ".env"));
    const result = await migrateLegacyCheckout(checkout, silent);
    if (!result.migrated) throw new Error("expected a migration");
    expect(readFileSync(result.envPath, "utf8")).toBe("");
    expect(result.trackers).toContain("jira/DEV");
  });

  test("registers a checkout with a local-path remote by its directory", async () => {
    git(checkout, ["remote", "set-url", "origin", join(root, "origin.git")]);
    const result = await migrateLegacyCheckout(checkout, silent);
    expect(result.migrated).toBe(true);
    const repo = loadWorkspaceConfig(join(workspace, "workspace.toml")).repos[0];
    expect(repo?.path).toBe(checkout);
    expect(existsSync(join(checkout, ".devintern-code", ".env"))).toBe(false);
  });
});

describe("moveLegacyCheckoutState", () => {
  test("moves the sign-in from any depth of the checkout, keeping a workspace session", () => {
    const sub = join(checkout, "packages", "app");
    mkdirSync(sub, { recursive: true });
    moveLegacyCheckoutState(sub);
    const target = join(workspace, "state", "code", ".auth-session.json");
    expect(readFileSync(target, "utf8")).toBe("{}");
    expect(existsSync(join(checkout, ".devintern-code", ".auth-session.json"))).toBe(false);

    writeFileSync(join(checkout, ".devintern-code", ".auth-session.json"), "stale");
    moveLegacyCheckoutState(checkout);
    expect(readFileSync(target, "utf8")).toBe("{}");
  });
});

describe("migrateCommittedTrackerSettings", () => {
  test("copies a worktree's committed tracker settings once and warns about its pipeline", () => {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "workspace.toml"), '[defaults]\ntracker = "jira"\n');
    const logs: string[] = [];
    const log = (message: string) => void logs.push(message);
    expect(migrateCommittedTrackerSettings(workspace, checkout, log).sort()).toEqual([
      "github/acme/web",
      "jira/DEV",
      "jira/LEG",
    ]);
    expect(migrateCommittedTrackerSettings(workspace, checkout, log)).toEqual([]);
    expect(logs.filter((line) => line.includes("defines a pipeline"))).toHaveLength(1);
    expect(loadWorkspaceTrackerSettings(workspace)?.jira?.projects?.DEV?.prStatus).toBe(
      "In Review",
    );
  });

  test("never throws for a missing workspace or unreadable settings", () => {
    writeFileSync(join(checkout, ".devintern-code", "settings.json"), "{not json");
    expect(migrateCommittedTrackerSettings(workspace, checkout, silent)).toEqual([]);
  });
});

describe("appendTrackerSettings", () => {
  test("adds only project keys the workspace does not define", () => {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      join(workspace, "workspace.toml"),
      '[defaults]\ntracker = "jira"\n\n[trackers.jira.projects.DEV]\npr_status = "Keep"\n',
    );
    const validate = (text: string) => void parseWorkspaceConfig(text);
    expect(appendTrackerSettings(workspace, SETTINGS, validate).sort()).toEqual([
      "github/acme/web",
      "jira/LEG",
    ]);
    const settings = loadWorkspaceTrackerSettings(workspace);
    expect(settings?.jira?.projects?.DEV?.prStatus).toBe("Keep");
    expect(appendTrackerSettings(workspace, SETTINGS, validate)).toEqual([]);
  });
});
