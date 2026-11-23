import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { WORKER_SUBPROCESS_ENV } from "../src/lib/config/config-dir";
import { loadWorkspaceConfig, parseWorkspaceConfig } from "../src/lib/workspace/config";
import { migrateLegacyCheckout } from "../src/lib/workspace/migrate-checkout";
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

  test("skips worker subprocesses, unrecognised remotes, and checkouts without a local .env", async () => {
    process.env[WORKER_SUBPROCESS_ENV] = "1";
    expect((await migrateLegacyCheckout(checkout, silent)).migrated).toBe(false);
    delete process.env[WORKER_SUBPROCESS_ENV];

    git(checkout, ["remote", "set-url", "origin", join(root, "origin.git")]);
    expect((await migrateLegacyCheckout(checkout, silent)).migrated).toBe(false);
    expect(existsSync(join(checkout, ".devintern-code", ".env"))).toBe(true);
    expect(existsSync(workspace)).toBe(false);

    git(checkout, ["remote", "set-url", "origin", "git@github.com:acme/web.git"]);
    rmSync(join(checkout, ".devintern-code", ".env"));
    expect((await migrateLegacyCheckout(checkout, silent)).migrated).toBe(false);
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
