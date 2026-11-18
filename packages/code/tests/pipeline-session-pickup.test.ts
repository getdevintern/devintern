/**
 * Pipeline-level session pickup wiring: the resolver, the current-run
 * exclusion, the prepare-branch step inheriting the recorded branch, and the
 * git-gated prompt context all have to line up for a restart/retry to actually
 * resume instead of redoing work.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContext } from "../src/lib/cli/context";
import {
  RunStore,
  beginRun,
  endRun,
  getActiveRunContext,
  recordRunPr,
} from "../src/lib/state/run-recorder";
import { pickupSelection, resolveSessionPickup } from "../src/lib/state/session-pickup";
import type { SessionPickupDecision } from "../src/lib/state/session-pickup";
import {
  buildRetryPromptContext,
  isChangeRequestOpen,
  reopenSucceededPickupOption,
  taskSteps,
} from "../src/lib/task/pipeline";
import { runTaskSteps } from "../src/lib/task/step-runner";
import { MarkdownTaskTrackerClient } from "../src/lib/trackers/markdown/markdown-task-tracker-client";
import { Utils } from "../src/lib/utils";
import { WORKSPACE_REPO_ENV } from "../src/lib/workspace/env";
import type { FormattedTaskDetails } from "../src/types/task-tracker";

let dbPath: string;
let store: RunStore;
let originalOptions: typeof runContext.options;
let originalContinue: typeof Utils.continueFeatureBranch | undefined;
let originalCreate: typeof Utils.createFeatureBranch;
let outputDirEnv: string | undefined;
let workspaceRepo: string | undefined;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `pipeline-pickup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  store = new RunStore(dbPath);
  originalOptions = runContext.options;
  originalContinue = Utils.continueFeatureBranch;
  originalCreate = Utils.createFeatureBranch;
  outputDirEnv = process.env.DEVINTERN_OUTPUT_DIR;
  process.env.DEVINTERN_OUTPUT_DIR = `${dbPath}.output`;
  workspaceRepo = process.env[WORKSPACE_REPO_ENV];
  delete process.env[WORKSPACE_REPO_ENV];
});

afterEach(() => {
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  runContext.options = originalOptions;
  Utils.createFeatureBranch = originalCreate;
  rmSync(`${dbPath}.output`, { recursive: true, force: true });
  if (outputDirEnv === undefined) delete process.env.DEVINTERN_OUTPUT_DIR;
  else process.env.DEVINTERN_OUTPUT_DIR = outputDirEnv;
  if (originalContinue) {
    Utils.continueFeatureBranch = originalContinue;
  }
  if (workspaceRepo === undefined) {
    delete process.env[WORKSPACE_REPO_ENV];
  } else {
    process.env[WORKSPACE_REPO_ENV] = workspaceRepo;
  }
});

function resumableRun(taskKey: string, branch: string, report: string): number {
  const runId = store.createRun({ origin: "task", taskKey, branch });
  store.addStage(runId, "implementation", "succeeded", "implemented", JSON.stringify({ report }));
  store.finishRun(runId, "failed", "agent exited non-zero");
  return runId;
}

describe("pipeline session pickup wiring", () => {
  test.each([true, false])(
    "writes the actual branch preparation outcome into the prompt (resumed=%s)",
    async (resumed) => {
      runContext.options = { git: true } as never;
      Utils.continueFeatureBranch = async (branch) => ({
        success: resumed,
        branchName: branch,
        message: "checkout outcome",
      });
      Utils.createFeatureBranch = async () => ({
        success: true,
        branchName: "feature/proj-1-attempt-2",
        message: "fresh branch",
      });
      const context = {
        taskKey: "PROJ-1",
        workflowKey: "PROJ-1",
        effectiveTargetBranch: "main",
        resumeBranch: "feature/proj-1",
        task: {},
        tracker: {},
        relatedIssues: [],
        priorRetryState: null,
        taskDetails: {
          key: "PROJ-1",
          summary: "Implement feature",
          issueType: "Story",
          status: "To Do",
          priority: "Medium",
          reporter: "pm@example.com",
          created: "2026-01-01",
          updated: "2026-01-01",
          description: "Implement feature",
          labels: [],
          components: [],
          fixVersions: [],
          comments: [],
          attachments: [],
          linkedResources: [],
          relatedIssues: [],
        } as FormattedTaskDetails,
        pickup: {
          kind: "resume",
          session: {
            runId: 1,
            taskKey: "PROJ-1",
            status: "failed",
            branch: "feature/proj-1",
            report: "inherited report",
          },
        } as SessionPickupDecision,
        outputFile: "",
        taskDir: "",
        attachmentMap: new Map(),
      };
      const steps = taskSteps.filter((step) =>
        ["prepare-branch", "prepare-prompt"].includes(step.name),
      );
      await runTaskSteps(steps, context as never);
      const prompt = readFileSync(context.outputFile, "utf8");
      expect(prompt.includes("checked out for you")).toBe(resumed);
      expect(prompt.includes("inherited report")).toBe(resumed);
      if (resumed) expect(context.resumeBranch).toBe("feature/proj-1");
      else expect(context.resumeBranch).toBeUndefined();
    },
  );
  test("a local task-file prompt tells the agent to continue the resumed branch", async () => {
    // Ad-hoc `worker add` tasks are local task files; a re-queue that resumes
    // the prior branch must carry the same guidance as tracker prompts.
    runContext.options = { git: true } as never;
    Utils.continueFeatureBranch = async (branch) => ({
      success: true,
      branchName: branch,
      message: "resumed",
    });
    const taskDir = `${dbPath}.output/task-src`;
    mkdirSync(taskDir, { recursive: true });
    const mdFile = join(taskDir, "local-add-helper.md");
    writeFileSync(mdFile, "# Add helper\n\nAdd truncate() to lib/utils.\n");
    const tracker = new MarkdownTaskTrackerClient({ cwd: taskDir });
    const task = await tracker.getTask(mdFile);
    const context = {
      taskKey: mdFile,
      workflowKey: "local-add-helper",
      effectiveTargetBranch: "main",
      resumeBranch: "feature/local-add-helper",
      task,
      tracker,
      relatedIssues: [],
      priorRetryState: null,
      taskDetails: tracker.formatTaskDetails(task, [], [], []),
      pickup: {
        kind: "resume",
        session: {
          runId: 591,
          taskKey: "local-add-helper",
          status: "succeeded",
          branch: "feature/local-add-helper",
          report: "added truncate() and pushed",
        },
      } as SessionPickupDecision,
      outputFile: "",
      taskDir: "",
      attachmentMap: new Map(),
    };
    const steps = taskSteps.filter((step) =>
      ["prepare-branch", "prepare-prompt"].includes(step.name),
    );
    await runTaskSteps(steps, context as never);
    const prompt = readFileSync(context.outputFile, "utf8");
    expect(prompt).toContain("Add truncate() to lib/utils.");
    expect(prompt).toContain("`feature/local-add-helper`, which has been\nchecked out for you");
    expect(prompt).toContain("added truncate() and pushed");
    expect(prompt).toContain("do not reimplement it");
  });

  test("resumes the excluded prior attempt's branch through the prepare-branch step", async () => {
    const prior = resumableRun("PROJ-1", "feature/proj-1", "prior report");
    // The pipeline opens the current run before resolving pickup; the resolver
    // must skip it and pick the prior terminal attempt.
    const current = store.createRun({ origin: "task", taskKey: "PROJ-1" });

    const pickup = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-1",
      ...pickupSelection(current, {} as NodeJS.ProcessEnv),
      branchExists: () => true,
    });

    expect(pickup.kind).toBe("resume");
    if (pickup.kind !== "resume") return;
    expect(pickup.session.runId).toBe(prior);
    expect(pickup.session.branch).toBe("feature/proj-1");

    const resumed: string[] = [];
    Utils.continueFeatureBranch = async (branch) => {
      resumed.push(branch);
      return { success: true, branchName: branch, message: `Resumed '${branch}'` };
    };
    runContext.options = { git: true } as never;

    const step = taskSteps.find((candidate) => candidate.name === "prepare-branch");
    expect(step).toBeDefined();
    await runTaskSteps([step!], {
      taskKey: "PROJ-1",
      workflowKey: "PROJ-1",
      effectiveTargetBranch: "main",
      resumeBranch: pickup.session.branch,
    } as never);

    expect(resumed).toEqual(["feature/proj-1"]);
  });

  test("reuses a report-less branch with commits instead of creating an attempt branch", async () => {
    // Interrupted during auto-review: the branch holds the implementation but
    // no implementation stage was saved. Pickup must resume the same branch.
    const prior = store.createRun({
      origin: "task",
      taskKey: "PROJ-1",
      branch: "feature/proj-1",
    });
    store.finishRun(prior, "failed", "worker restarted during auto-review");
    const current = store.createRun({ origin: "task", taskKey: "PROJ-1" });

    const pickup = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-1",
      ...pickupSelection(current, {} as NodeJS.ProcessEnv),
      branchExists: () => true,
      hasLandedCommits: () => true,
    });

    expect(pickup.kind).toBe("resume");
    if (pickup.kind !== "resume") return;
    expect(pickup.session.runId).toBe(prior);
    expect(pickup.session.report).toBeUndefined();

    const resumed: string[] = [];
    let createdFresh = false;
    Utils.continueFeatureBranch = async (branch) => {
      resumed.push(branch);
      return { success: true, branchName: branch, message: `Resumed '${branch}'` };
    };
    Utils.createFeatureBranch = async () => {
      createdFresh = true;
      return { success: true, branchName: "feature/proj-1-attempt-2", message: "fresh" };
    };
    runContext.options = { git: true } as never;

    const step = taskSteps.find((candidate) => candidate.name === "prepare-branch");
    expect(step).toBeDefined();
    await runTaskSteps([step!], {
      taskKey: "PROJ-1",
      workflowKey: "PROJ-1",
      effectiveTargetBranch: "main",
      resumeBranch: pickup.session.branch,
    } as never);

    expect(resumed).toEqual(["feature/proj-1"]);
    expect(createdFresh).toBe(false);
  });

  test("--no-git yields no resume branch claim in the prompt context", () => {
    const pickup: SessionPickupDecision = {
      kind: "resume",
      session: {
        runId: 1,
        taskKey: "PROJ-1",
        status: "failed",
        branch: "feature/proj-1",
        report: "prior report",
        landed: "commits on feature/proj-1",
        outcomeReason: "agent exited non-zero",
      },
    };

    const withGit = buildRetryPromptContext({
      pickup,
      priorRetryState: null,
      gitEnabled: true,
    });
    expect(withGit).toMatchObject({
      resumeBranch: "feature/proj-1",
      previousReport: "prior report",
      landedWork: "commits on feature/proj-1",
      previousFailureSummary: "agent exited non-zero",
    });

    const withoutGit = buildRetryPromptContext({
      pickup,
      priorRetryState: null,
      gitEnabled: false,
    });
    expect(withoutGit?.resumeBranch).toBeUndefined();
    expect(withoutGit?.previousReport).toBeUndefined();
    expect(withoutGit?.landedWork).toBeUndefined();
    // The failure summary is not git-gated and still helps the agent.
    expect(withoutGit?.previousFailureSummary).toBe("agent exited non-zero");
  });

  test("no retry state and no pickup yields no prompt context", () => {
    expect(
      buildRetryPromptContext({
        pickup: { kind: "fresh", reason: "no prior attempt on record" },
        priorRetryState: null,
        gitEnabled: true,
      }),
    ).toBeUndefined();
  });
});

/**
 * A `succeeded` ad-hoc run that left a branch behind, as `worker add` run 591
 * did when its PR step failed on bad credentials (`prUrl` unset) or when its PR
 * is still open (`prUrl` set).
 */
function succeededLocalRun(taskKey: string, branch: string, prUrl?: string): number {
  const runId = store.createRun({ origin: "local", taskKey, branch, ...(prUrl ? { prUrl } : {}) });
  store.addStage(
    runId,
    "implementation",
    "succeeded",
    "implemented",
    JSON.stringify({ report: "done" }),
  );
  store.finishRun(runId, "succeeded");
  return runId;
}

type PrState = "open" | "closed" | "none" | undefined;

describe("ad-hoc re-queue pickup wiring", () => {
  const KEY = "local-add-truncate-helper";
  const BRANCH = "feature/local-add-truncate-helper";
  const PR = "https://github.com/owner/repo/pull/12";

  test.each<[PrState | "throws", boolean | undefined]>([
    ["open", true],
    ["closed", false],
    // The run recorded a PR but the host has none for the branch: unexplained, so unknown.
    ["none", undefined],
    // Unsupported host, no credentials, or a 401/403/429/5xx lookup failure.
    [undefined, undefined],
    ["throws", undefined],
  ])("maps PR state %p to open=%p", async (state, expected) => {
    const lookup = async (): Promise<PrState> => {
      if (state === "throws") throw new Error("Bad credentials");
      return state;
    };
    expect(await isChangeRequestOpen(BRANCH, lookup)).toBe(expected);
  });

  test("only local runs with git delivery may reopen a succeeded run", () => {
    expect(
      reopenSucceededPickupOption({ origin: "local", gitEnabled: true }).reopenSucceeded,
    ).toBeDefined();
    expect(reopenSucceededPickupOption({ origin: "local", gitEnabled: false })).toEqual({});
    expect(reopenSucceededPickupOption({ origin: "task", gitEnabled: true })).toEqual({});
    expect(reopenSucceededPickupOption({ origin: undefined, gitEnabled: true })).toEqual({});
  });

  async function pickupFor(origin: string, lookup: () => Promise<PrState>) {
    const current = store.createRun({ origin: origin as "local", taskKey: KEY });
    const pickup = await resolveSessionPickup({
      runStore: store,
      taskKey: KEY,
      // The pipeline scopes pickup by the current run's own record.
      scope: store.getRun(current) ?? {},
      ...pickupSelection(current, {} as NodeJS.ProcessEnv),
      ...reopenSucceededPickupOption({ origin, gitEnabled: true, lookup }),
      branchExists: () => true,
      hasLandedCommits: () => true,
    });
    return pickup;
  }

  test("a pushed-without-PR branch resumes without asking the code host", async () => {
    const prior = succeededLocalRun(KEY, BRANCH);
    let lookups = 0;
    const pickup = await pickupFor("local", async () => {
      lookups++;
      return undefined;
    });
    expect(pickup).toMatchObject({ kind: "resume", session: { runId: prior, branch: BRANCH } });
    expect(lookups).toBe(0);
  });

  test.each<[string, () => Promise<PrState>, "resume" | "fresh", string | undefined]>([
    ["open", async () => "open", "resume", undefined],
    ["merged or closed", async () => "closed", "fresh", "no longer open"],
    // An expired token must not read as "PR closed", but it is not proof the PR
    // is open either: stay on the safe fresh path and say why.
    [
      "unverifiable (401)",
      async () => {
        throw new Error("401 Bad credentials");
      },
      "fresh",
      "could not confirm",
    ],
    ["unverifiable (no PR found)", async () => "none", "fresh", "could not confirm"],
  ])("a recorded PR that is %s → %s", async (_label, lookup, kind, reason) => {
    succeededLocalRun(KEY, BRANCH, PR);
    const pickup = await pickupFor("local", lookup);
    expect(pickup.kind).toBe(kind);
    if (pickup.kind === "fresh") expect(pickup.reason).toContain(reason!);
  });

  test("a succeeded tracker-task run stays final", async () => {
    const runId = store.createRun({ origin: "task", taskKey: KEY, branch: BRANCH });
    store.finishRun(runId, "succeeded");
    const pickup = await pickupFor("task", async () => "open");
    expect(pickup.kind).toBe("fresh");
  });

  test("the resumed run records the branch its reused PR is on", async () => {
    succeededLocalRun(KEY, BRANCH, PR);
    const pickup = await pickupFor("local", async () => "open");
    expect(pickup.kind).toBe("resume");
    if (pickup.kind !== "resume") return;

    let createdFresh = false;
    Utils.continueFeatureBranch = async (branch) => ({
      success: true,
      branchName: branch,
      message: `Resumed '${branch}'`,
    });
    Utils.createFeatureBranch = async () => {
      createdFresh = true;
      return { success: true, branchName: `${BRANCH}-attempt-2`, message: "fresh" };
    };
    runContext.options = { git: true } as never;

    beginRun({ origin: "local", taskKey: KEY });
    const runId = getActiveRunContext()?.id;
    expect(runId).toBeDefined();
    try {
      const step = taskSteps.find((candidate) => candidate.name === "prepare-branch");
      await runTaskSteps([step!], {
        taskKey: KEY,
        workflowKey: KEY,
        effectiveTargetBranch: "main",
        resumeBranch: pickup.session.branch,
      } as never);
      // The PR step adopts the existing PR (GitHub 422 → existing lookup) and
      // records it on the new run; dependents read branch + PR from here.
      recordRunPr({ repo: "owner/repo", prNumber: 12, url: PR });
    } finally {
      endRun("succeeded");
    }

    expect(createdFresh).toBe(false);
    const recorder = new RunStore();
    try {
      const recorded = recorder.getRun(runId!);
      expect(recorded?.branch).toBe(BRANCH);
      expect(recorded?.prUrl).toBe(PR);
    } finally {
      recorder.close();
    }
  });
});
