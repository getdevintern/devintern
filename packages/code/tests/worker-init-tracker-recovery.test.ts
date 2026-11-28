/**
 * `devintern worker init` recovering from a tracker repository/token
 * mismatch inside the wizard: going back from the query step to the tracker
 * step, and the info line when GitHub Issues live in another repository than
 * the code.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { runWorkerInit } from "../src/lib/init/worker-init";
import { runWorkerInitSteps } from "../src/lib/init/worker-init-steps";
import type { WorkerInitStep } from "../src/lib/init/worker-init-steps";
import { MAX_TRACKER_REVISITS } from "../src/lib/init/worker-init-tracker";
import { emptyOutcome } from "../src/lib/init/worker-init-run";
import type { PromptRun, SetupRun } from "../src/lib/init/worker-init-run";
import { trackerRepoNotice } from "../src/lib/trackers/github/tracker-repo-notice";
import { loadWorkspaceConfig } from "../src/lib/workspace/config";

const NO_ACCESS =
  'GitHub API error (422): {"message":"Validation Failed","errors":[{"message":"The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them.","resource":"Search","field":"q","code":"invalid"}],"status":"422"}';

const BACK_PROMPT = "[b]ack to the tracker step / [k]eep and fix later [b]: ";

describe("worker init tracker recovery", () => {
  let tempDir: string;
  let workspaceDir: string;
  let logs: string[];
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "TASK_TRACKER",
    "DEVINTERN_WORKSPACE_DIR",
    "GITHUB_TOKEN",
    "GITHUB_REPO",
    "LICENSE_KEY",
  ];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    tempDir = mkdtempSync(path.join(tmpdir(), "devintern-worker-recovery-"));
    workspaceDir = path.join(tempDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      path.join(workspaceDir, "workspace.toml"),
      '[defaults]\ntracker = "github"\n\n[[repos]]\nname = "app"\nremote = "git@github.com:acme/app.git"\n',
    );
    process.env.TASK_TRACKER = "github";
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.GITHUB_REPO = "acme/no-access-app";
    delete process.env.LICENSE_KEY;
    logs = [];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Hermetic wizard deps. `answers` replies to the questions in order (other
   * questions get Enter); the dry run fails with an access error until
   * GITHUB_REPO is acme/app.
   */
  function deps(answers: string[], overrides: Partial<Parameters<typeof runWorkerInit>[0]> = {}) {
    const questions: string[] = [];
    const queries: string[] = [];
    const reconfigured: string[] = [];
    let bootstraps = 0;
    return {
      questions,
      queries,
      reconfigured,
      bootstraps: () => bootstraps,
      deps: {
        cwd: tempDir,
        log: (message: string) => logs.push(message),
        prompt: async (question: string) => {
          questions.push(question);
          return answers.shift() ?? "";
        },
        ensureTracker: async () => "github",
        reconfigureTracker: async ({ trackerType }: { trackerType: string }) => {
          reconfigured.push(trackerType);
          process.env.GITHUB_REPO = "acme/app";
          return true;
        },
        dryRunQuery: async (query: string) => {
          queries.push(query);
          if (process.env.GITHUB_REPO !== "acme/app") throw new Error(NO_ACCESS);
          return 2;
        },
        bootstrapWorkspace: async () => {
          bootstraps++;
          return { workspaceDir, created: false, repoName: "app" };
        },
        githubCliToken: () => null,
        detectGithubRepo: async () => null,
        noService: true,
        getUser: async () => null,
        signIn: async () => null,
        ...overrides,
      },
    };
  }

  test("an access failure offers back to the tracker step, then the query works", async () => {
    const d = deps(["is:open label:ai", "b", ""]);
    const result = await runWorkerInit(d.deps);
    expect(result.ok).toBe(true);
    expect(d.questions).toContain(BACK_PROMPT);
    expect(d.reconfigured).toEqual(["github"]);
    // Tracker, workspace, and token steps ran again before the query step.
    expect(d.bootstraps()).toBe(2);
    expect(d.queries).toEqual(["is:open label:ai", "is:open label:ai"]);
    const text = logs.join("\n");
    expect(text).toContain("GitHub can't search acme/no-access-app");
    expect(text).toContain("1️⃣  Tracker configuration (again)");
    expect(text).toContain("✅ Query works: 2 task(s) match right now.");
    expect(text).not.toContain("Keeping the query. Fix the token");
    // The query typed before going back is the Enter default afterwards.
    expect(d.questions.filter((q) => q.startsWith("Ready-tasks query"))[1]).toBe(
      "Ready-tasks query [is:open label:ai]: ",
    );
    const config = loadWorkspaceConfig(path.join(workspaceDir, "workspace.toml"));
    expect(config.defaults.taskQuery).toBe("is:open label:ai");
  });

  test("k keeps the query and says where to fix the settings", async () => {
    const d = deps(["is:open label:ai", "k"]);
    const result = await runWorkerInit(d.deps);
    expect(result.ok).toBe(true);
    expect(d.reconfigured).toEqual([]);
    expect(d.queries).toHaveLength(1);
    expect(logs.join("\n")).toContain(
      `Keeping the query. Fix the token or GITHUB_REPO in ${path.join(workspaceDir, ".env")}`,
    );
    const config = loadWorkspaceConfig(path.join(workspaceDir, "workspace.toml"));
    expect(config.defaults.taskQuery).toBe("is:open label:ai");
  });

  test("a query syntax error does not offer the tracker step", async () => {
    const d = deps(["bad query", "n"], {
      dryRunQuery: async () => {
        throw new Error("Invalid search query");
      },
    });
    const result = await runWorkerInit(d.deps);
    expect(result.ok).toBe(true);
    expect(d.questions).not.toContain(BACK_PROMPT);
    expect(d.questions).toContain("Edit the query and try again? [Y/n]: ");
  });

  test(`stops offering back after ${MAX_TRACKER_REVISITS} visits`, async () => {
    const answers = ["is:open"];
    for (let i = 0; i < MAX_TRACKER_REVISITS; i++) answers.push("b", "");
    const d = deps(answers, {
      // The settings never get fixed.
      reconfigureTracker: async () => true,
    });
    const result = await runWorkerInit(d.deps);
    expect(result.ok).toBe(true);
    expect(d.questions.filter((q) => q === BACK_PROMPT)).toHaveLength(MAX_TRACKER_REVISITS);
    expect(d.queries).toHaveLength(MAX_TRACKER_REVISITS + 1);
    expect(logs.join("\n")).toContain("Keeping the query. Fix the token");
  });

  test("an aborted tracker revisit stops setup", async () => {
    const d = deps(["is:open", "b"], { reconfigureTracker: async () => false });
    const result = await runWorkerInit(d.deps);
    expect(result.ok).toBe(false);
    expect(logs.join("\n")).toContain("Tracker setup did not finish");
  });

  test("the tracker step names a tracker repo the worker does not open PRs in", async () => {
    process.env.GITHUB_REPO = "acme/issues";
    const d = deps(["is:open"], { dryRunQuery: async () => 1 });
    const result = await runWorkerInit(d.deps);
    expect(result.ok).toBe(true);
    expect(logs.join("\n")).toContain("ℹ️  Tickets come from acme/issues, PRs go to acme/app.");
  });

  test("no notice when the tracker repo is the worker's repo", async () => {
    process.env.GITHUB_REPO = "acme/app";
    const d = deps(["is:open"]);
    const result = await runWorkerInit(d.deps);
    expect(result.ok).toBe(true);
    expect(logs.join("\n")).not.toContain("Tickets come from");
  });
});

describe("runWorkerInitSteps", () => {
  function promptRun(): PromptRun {
    return {
      input: "prompt",
      deps: {},
      cwd: "/tmp",
      projectRoot: "/tmp",
      log: () => {},
      prompt: async () => "",
      promptSecret: async () => "",
      guard: ((promise: Promise<unknown>) => promise) as PromptRun["guard"],
      trackerType: "github",
      trackerName: "GitHub Issues",
      workspaceDir: "",
      outcome: emptyOutcome(),
    };
  }

  test("going back re-runs from the named step and marks it revisited", async () => {
    const order: string[] = [];
    let wentBack = false;
    const steps: WorkerInitStep[] = [
      { id: "a", run: async () => (order.push("a"), true) },
      {
        id: "b",
        run: async (run: SetupRun) => {
          order.push(`b${run.input === "prompt" && run.revisit === "b" ? "*" : ""}`);
          if (run.input === "prompt") run.revisit = undefined;
          return true;
        },
      },
      { id: "c", run: async () => (order.push("c"), true) },
      {
        id: "d",
        run: async () => {
          order.push("d");
          if (wentBack) return true;
          wentBack = true;
          return { back: "b" };
        },
      },
    ];
    expect(await runWorkerInitSteps(promptRun(), steps)).toBe(true);
    expect(order).toEqual(["a", "b", "c", "d", "b*", "c", "d"]);
  });

  test("going forward or to an unknown step is a programming error", async () => {
    const steps: WorkerInitStep[] = [
      { id: "a", run: async () => ({ back: "b" }) },
      { id: "b", run: async () => true },
    ];
    await expect(runWorkerInitSteps(promptRun(), steps)).rejects.toThrow("cannot go back");
  });
});

describe("trackerRepoNotice", () => {
  test("names both sides when the tracker repo is none of the PR repos", () => {
    expect(trackerRepoNotice("acme/issues", ["acme/app", null, "acme/app", "acme/web"])).toBe(
      "Tickets come from acme/issues, PRs go to acme/app, acme/web",
    );
  });

  test("is null for a matching repo (any case) or an unknown side", () => {
    expect(trackerRepoNotice("Acme/App", ["acme/app"])).toBeNull();
    expect(trackerRepoNotice(undefined, ["acme/app"])).toBeNull();
    expect(trackerRepoNotice("acme/issues", [null])).toBeNull();
  });
});
