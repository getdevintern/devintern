/**
 * Pipeline-level session pickup wiring: the resolver, the current-run
 * exclusion, the prepare-branch step inheriting the recorded branch, and the
 * git-gated prompt context all have to line up for a restart/retry to actually
 * resume instead of redoing work.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContext } from "../src/lib/cli/context";
import { RunStore } from "../src/lib/state/run-recorder";
import { pickupSelection, resolveSessionPickup } from "../src/lib/state/session-pickup";
import type { SessionPickupDecision } from "../src/lib/state/session-pickup";
import { buildRetryPromptContext, taskSteps } from "../src/lib/task/pipeline";
import { runTaskSteps } from "../src/lib/task/step-runner";
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
