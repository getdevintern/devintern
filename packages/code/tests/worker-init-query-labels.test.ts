/**
 * Labels a ready-tasks query names but the repository lacks: extraction from
 * GitHub-style queries, and the `worker init --non-interactive` warning plus
 * `fix-query` next step. The wizard side lives in worker-init.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { DevinternLabelOpsFactory } from "../src/lib/init/worker-init-label";
import { runNonInteractiveWorkerInit } from "../src/lib/init/worker-init-noninteractive";
import type {
  NonInteractiveInitArgs,
  NonInteractiveInitDeps,
} from "../src/lib/init/worker-init-noninteractive";
import { queryLabelsToCheck } from "../src/lib/init/worker-init-query-labels";
import type { WorkerDoctorDeps } from "../src/lib/observability/worker-readiness";
import { extractQueryLabels } from "../src/lib/trackers/query-labels";

describe("extractQueryLabels", () => {
  test("unquoted, quoted, and multiple label terms", () => {
    expect(extractQueryLabels("is:open label:bug")).toEqual(["bug"]);
    expect(extractQueryLabels('is:open label:"good first issue"')).toEqual(["good first issue"]);
    expect(extractQueryLabels("label:'needs triage' is:open")).toEqual(["needs triage"]);
    expect(extractQueryLabels('label:bug is:open label:"ready to go" label:p1')).toEqual([
      "bug",
      "ready to go",
      "p1",
    ]);
  });

  test("comma-separated values, labels: key, and case-insensitive duplicates", () => {
    expect(extractQueryLabels('label:bug,"help wanted",docs')).toEqual([
      "bug",
      "help wanted",
      "docs",
    ]);
    expect(extractQueryLabels("Label:Bug labels:backend label:bug")).toEqual(["Bug", "backend"]);
  });

  test("negated -label: terms are ignored", () => {
    expect(extractQueryLabels('is:open label:ready -label:wontfix -label:"on hold"')).toEqual([
      "ready",
    ]);
  });

  test("no label term, or label: inside another word, yields nothing", () => {
    expect(extractQueryLabels("is:open assignee:@me")).toEqual([]);
    expect(extractQueryLabels("nolabel:x is:open")).toEqual([]);
    expect(extractQueryLabels("is:open label:")).toEqual([]);
    expect(extractQueryLabels("")).toEqual([]);
  });
});

describe("queryLabelsToCheck", () => {
  test("only trackers with a label API, minus skipped names and GitLab keywords", () => {
    expect(queryLabelsToCheck("github", "label:devintern label:bug", ["DevIntern"])).toEqual([
      "bug",
    ]);
    expect(queryLabelsToCheck("gitlab", "label:None label:Any label:bug")).toEqual(["bug"]);
    expect(queryLabelsToCheck("trello", "label:bug is:open")).toEqual([]);
    expect(queryLabelsToCheck("jira", "labels = bug")).toEqual([]);
  });
});

const GITHUB_ENV = { GITHUB_TOKEN: "ghp_queryLabelsSecret0123456789", GITHUB_REPO: "acme/app" };

function doctorStubs(overrides: WorkerDoctorDeps = {}): WorkerDoctorDeps {
  return {
    dryRunQuery: async () => 0,
    checkRepoAccess: async () => ({ ok: true, detail: "readable and writable" }),
    checkEntitlement: async () => ({ valid: true, source: "license-key", message: "ok" }),
    checkHarness: async () => ({ id: "harness", label: "Agent harness", status: "ok" }),
    checkSandbox: async () => ({ id: "sandbox", label: "Agent sandbox", status: "ok" }),
    checkGitIdentity: async () => ({ id: "git-identity", label: "Git identity", status: "ok" }),
    isPortInUse: async () => false,
    workerStatus: () => ({ status: "stopped" }),
    notificationChannelDeps: undefined,
    ...overrides,
  };
}

/** Label ops where only `existing` labels exist; records lookups and creations. */
function repoLabels(existing: string[], lookupError?: Error) {
  const calls = { exists: [] as string[], create: [] as string[] };
  const factory: DevinternLabelOpsFactory = () => ({
    location: "acme/app",
    exists: async (name = "devintern") => {
      calls.exists.push(name);
      if (lookupError) throw lookupError;
      return existing.includes(name);
    },
    create: async (name = "devintern") => {
      calls.create.push(name);
    },
  });
  return { calls, factory };
}

describe("worker init --non-interactive query labels", () => {
  let root: string;
  let workspaceDir: string;
  let repoDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "worker-query-labels-"));
    workspaceDir = join(root, "workspace");
    repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    execSync("git init -q -b main", { cwd: repoDir, stdio: "ignore" });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(
    args: Partial<NonInteractiveInitArgs>,
    deps: Partial<NonInteractiveInitDeps> & { doctorOverrides?: WorkerDoctorDeps } = {},
  ) {
    const { doctorOverrides, ...rest } = deps;
    return runNonInteractiveWorkerInit(
      { repoFromCwd: false, json: true, yes: false, tracker: "github", ...args },
      {
        cwd: repoDir,
        workspaceDir,
        home: root,
        processEnv: { ...GITHUB_ENV },
        probe: async () => {},
        probeTimeoutMs: 2_000,
        which: () => null,
        doctor: doctorStubs(doctorOverrides),
        ...rest,
      },
    );
  }

  test("a missing label warns with a fix-query step and keeps the setup", async () => {
    const labels = repoLabels(["ready"]);
    const report = await run(
      { taskQuery: "is:open label:redy -label:wontfix" },
      { devinternLabelOps: labels.factory },
    );
    expect(report.result).toBe("success");
    expect(report.persisted).toBe(true);
    expect(labels.calls.exists).toEqual(["redy"]);
    expect(labels.calls.create).toEqual([]);
    const row = report.checks.find((check) => check.name === "query-labels");
    expect(row?.status).toBe("warn");
    expect(row?.message).toContain('Label "redy" does not exist in acme/app');
    // Right after the dry-run row it qualifies.
    const names = report.checks.map((check) => check.name);
    expect(names.indexOf("query-labels")).toBe(names.indexOf("query") + 1);
    const step = report.nextSteps.find((s) => s.id === "fix-query");
    expect(step?.command).toContain("--task-query '<query>'");
    expect(step?.message).toContain('Label "redy" does not exist');
  });

  test("every label present passes without a fix-query step", async () => {
    const labels = repoLabels(["bug", "help wanted"]);
    const report = await run(
      { taskQuery: 'is:open label:bug label:"help wanted"' },
      { devinternLabelOps: labels.factory },
    );
    expect(labels.calls.exists).toEqual(["bug", "help wanted"]);
    expect(report.checks.find((check) => check.name === "query-labels")?.status).toBe("pass");
    expect(report.nextSteps.some((s) => s.id === "fix-query")).toBe(false);
  });

  test("no API call when the query has no label term", async () => {
    const labels = repoLabels([]);
    const report = await run(
      { taskQuery: "is:open assignee:@me" },
      { devinternLabelOps: labels.factory },
    );
    expect(labels.calls.exists).toEqual([]);
    expect(report.checks.some((check) => check.name === "query-labels")).toBe(false);
  });

  test("not checked when the dry run failed", async () => {
    const labels = repoLabels([]);
    const report = await run(
      { taskQuery: "is:open label:redy" },
      {
        devinternLabelOps: labels.factory,
        doctorOverrides: { dryRunQuery: async () => Promise.reject(new Error("bad query")) },
      },
    );
    expect(labels.calls.exists).toEqual([]);
    expect(report.checks.some((check) => check.name === "query-labels")).toBe(false);
  });

  test("the default query's devintern label is checked once, by the label row", async () => {
    const labels = repoLabels([]);
    const report = await run({}, { devinternLabelOps: labels.factory });
    expect(report.taskQuery).toBe("is:open label:devintern");
    expect(labels.calls.exists).toEqual(["devintern"]);
    expect(report.checks.some((check) => check.name === "query-labels")).toBe(false);
  });

  test("a failed lookup is reported as skipped, not a failure", async () => {
    const labels = repoLabels([], new Error("GitHub API error (500): boom"));
    const report = await run(
      { taskQuery: "is:open label:bug" },
      { devinternLabelOps: labels.factory },
    );
    expect(report.result).toBe("success");
    const row = report.checks.find((check) => check.name === "query-labels");
    expect(row?.status).toBe("skipped");
    expect(row?.message).toContain("could not look up");
  });
});
