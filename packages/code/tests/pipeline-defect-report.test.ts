import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContext } from "../src/lib/cli/context";
import type { ProgramOptions } from "../src/lib/cli/program";
import { resolveDevInternPackageRoot } from "../src/lib/report/failure-analysis";
import {
  RunStore,
  beginRun,
  beginRunStep,
  getActiveRunContext,
} from "../src/lib/state/run-recorder";
import { handleTaskFailure } from "../src/lib/task/task-failure";
import { listSpoolEntries } from "../src/lib/report/store";
import { WORKER_SUBPROCESS_ENV, resolveRuntimeStateDir } from "../src/lib/config/config-dir";

const ENV_KEYS = [
  "DEVINTERN_AUTO_REPORT",
  "DEVINTERN_AUTO_REPORT_ACTIVE",
  "DEVINTERN_REPORT_EMAIL",
  "DEVINTERN_REPORT_URL",
  WORKER_SUBPROCESS_ENV,
  "DEVINTERN_WORKSPACE_DIR",
] as const;

/** A TypeError whose innermost frame is DevIntern's own pipeline code. */
function devInternTypeError(): TypeError {
  const root = resolveDevInternPackageRoot()!;
  const error = new TypeError("Cannot read properties of undefined (reading 'summary')");
  error.stack = [
    `TypeError: ${error.message}`,
    `    at formatTaskDetails (${root}/src/lib/task/formatter.ts:120:15)`,
    `    at async processTask (${root}/src/lib/task/pipeline.ts:610:7)`,
  ].join("\n");
  return error;
}

let workspace: string;
let savedEnv: Record<string, string | undefined>;
let savedOptions: ProgramOptions;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  savedOptions = runContext.options;
  runContext.options = { skipComments: true } as ProgramOptions;
  runContext.activeTaskContext = null;
  process.env.DEVINTERN_REPORT_EMAIL = "ops@example.com";
  // Worker runs keep report state in the workspace (pinned to a temp dir by
  // the test runner), never in the checkout's `.devintern-code`.
  process.env[WORKER_SUBPROCESS_ENV] = "1";
  // A fresh workspace per test, so one test's report is not another's duplicate.
  workspace = mkdtempSync(join(tmpdir(), "pipeline-defect-"));
  process.env.DEVINTERN_WORKSPACE_DIR = workspace;
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  runContext.options = savedOptions;
  rmSync(workspace, { recursive: true, force: true });
});

/** Fail a run at `implementation` and return what the pipeline rethrew plus the stored run. */
async function failRun(error: unknown) {
  beginRun({ origin: "task", taskKey: "PIPE-1" });
  const runId = getActiveRunContext()!.id;
  beginRunStep("implementation");
  // totalTasks > 1 rethrows instead of exiting, so the exit path is observable.
  const thrown = await handleTaskFailure(error, {
    taskKey: "PIPE-1",
    taskIndex: 0,
    totalTasks: 2,
  }).catch((caught: unknown) => caught);
  const store = new RunStore();
  try {
    return { thrown, run: store.getRun(runId), stages: store.listStages(runId) };
  } finally {
    store.close();
  }
}

function serveReports(handler: (request: Request) => Response | Promise<Response>): void {
  server = Bun.serve({ port: 0, fetch: handler });
  process.env.DEVINTERN_REPORT_URL = `http://127.0.0.1:${server.port}/api/reports`;
}

describe("handleTaskFailure automatic defect reports", () => {
  test("is off by default: no analysis stage, no request", async () => {
    let requests = 0;
    serveReports(() => {
      requests += 1;
      return new Response("{}");
    });
    const error = devInternTypeError();
    const { thrown, run, stages } = await failRun(error);
    expect(thrown).toBe(error);
    expect(run?.status).toBe("failed");
    expect(stages.some((stage) => stage.stage === "defect_report")).toBe(false);
    expect(requests).toBe(0);
  });

  test("records a reported defect on the failed run with the failed step", async () => {
    process.env.DEVINTERN_AUTO_REPORT = "1";
    const bodies: Array<{ description?: string }> = [];
    serveReports(async (request) => {
      bodies.push((await request.json()) as { description?: string });
      return Response.json({ id: "r-9", url: "https://devintern.com/reports/r-9" });
    });
    const error = devInternTypeError();
    const { thrown, run, stages } = await failRun(error);
    expect(thrown).toBe(error);
    expect(run?.status).toBe("failed");
    const stage = stages.find((entry) => entry.stage === "defect_report");
    expect(stage?.status).toBe("succeeded");
    expect(stage?.summary).toContain("https://devintern.com/reports/r-9");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.description).toContain("Failed step: implementation");
    const reportDir = join(resolveRuntimeStateDir(), "reports");
    expect(reportDir.startsWith(workspace)).toBe(true);
    expect(existsSync(reportDir) && listSpoolEntries(reportDir).length).toBe(1);
    expect(process.env.DEVINTERN_AUTO_REPORT_ACTIVE).toBeUndefined();
  });

  test("a failing intake keeps the original result and records the failure", async () => {
    process.env.DEVINTERN_AUTO_REPORT = "1";
    serveReports(() => new Response("boom", { status: 500 }));
    const error = devInternTypeError();
    const { thrown, run, stages } = await failRun(error);
    expect(thrown).toBe(error);
    expect(run?.status).toBe("failed");
    expect(run?.outcomeReason).toBe(error.message);
    const stage = stages.find((entry) => entry.stage === "defect_report");
    expect(stage?.status).toBe("failed");
  });

  test("a task failure is analysed but never sent", async () => {
    process.env.DEVINTERN_AUTO_REPORT = "1";
    let requests = 0;
    serveReports(() => {
      requests += 1;
      return new Response("{}");
    });
    const error = new Error("claude exited with code 1");
    const { thrown, run, stages } = await failRun(error);
    expect(thrown).toBe(error);
    expect(run?.status).toBe("failed");
    expect(stages.find((entry) => entry.stage === "defect_report")?.status).toBe("skipped");
    expect(requests).toBe(0);
  });
});
