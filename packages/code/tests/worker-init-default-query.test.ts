/**
 * The default ready-tasks query (open tickets labeled devintern) in
 * `worker init --non-interactive`: chosen per tracker when `--task-query` is
 * absent, overridden by the flag or a saved query, and label creation gated
 * on `--create-label`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { DevinternLabelOpsFactory } from "../src/lib/init/worker-init-label";
import {
  initRerunCommand,
  parseNonInteractiveInitArgs,
  runNonInteractiveWorkerInit,
} from "../src/lib/init/worker-init-noninteractive";
import type {
  NonInteractiveInitArgs,
  NonInteractiveInitDeps,
} from "../src/lib/init/worker-init-noninteractive";
import type { WorkerDoctorDeps } from "../src/lib/observability/worker-readiness";
import {
  TRACKER_CAPABILITIES,
  defaultQueryZeroMatchHint,
  defaultTaskQuery,
  isDefaultTaskQuery,
  supportsLabelCreation,
  trackersSupportingPolling,
} from "../src/lib/trackers/capabilities";
import { loadWorkspaceConfig } from "../src/lib/workspace/config";

const GITHUB_ENV = { GITHUB_TOKEN: "ghp_defaultQuerySecret0123456789", GITHUB_REPO: "acme/app" };
const JIRA_ENV = {
  JIRA_BASE_URL: "https://acme.atlassian.net",
  JIRA_EMAIL: "bot@acme.dev",
  JIRA_API_TOKEN: "jira-secret-token-0123456789",
};

function doctorStubs(overrides: WorkerDoctorDeps = {}): WorkerDoctorDeps {
  return {
    dryRunQuery: async () => 2,
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

/** Label operations that record calls instead of reaching a tracker. */
function labelStub(exists: boolean, createError?: Error) {
  const calls = { exists: 0, create: 0 };
  const factory: DevinternLabelOpsFactory = () => ({
    exists: async () => {
      calls.exists++;
      return exists;
    },
    create: async () => {
      calls.create++;
      if (createError) throw createError;
    },
  });
  return { calls, factory };
}

describe("default ready-tasks query per tracker", () => {
  test("every pollable tracker but asana and markdown has a devintern-label default", () => {
    for (const tracker of trackersSupportingPolling()) {
      const query = defaultTaskQuery(tracker);
      if (tracker === "asana" || tracker === "markdown") {
        expect(query).toBeUndefined();
        continue;
      }
      expect(query).toContain("devintern");
      expect(TRACKER_CAPABILITIES[tracker]?.labelHowTo).toBeTruthy();
    }
    expect(defaultTaskQuery("github")).toBe("is:open label:devintern");
    expect(defaultTaskQuery("gitlab")).toBe("is:open label:devintern");
    expect(defaultTaskQuery("jira")).toStartWith("labels = devintern AND statusCategory != Done");
    expect(JSON.parse(defaultTaskQuery("linear")!)).toMatchObject({
      labels: { name: { eqIgnoreCase: "devintern" } },
    });
    expect(defaultTaskQuery("azure-devops")).toContain("[System.Tags] CONTAINS 'devintern'");
    expect(defaultTaskQuery("trello")).toBe("label:devintern is:open");
  });

  test("only trackers with a label API create the label", () => {
    expect(supportsLabelCreation("github")).toBe(true);
    expect(supportsLabelCreation("gitlab")).toBe(true);
    for (const tracker of ["jira", "linear", "azure-devops", "trello", "asana", "markdown"]) {
      expect(supportsLabelCreation(tracker)).toBe(false);
    }
  });

  test("the zero-match label hint applies to the default query only", () => {
    expect(isDefaultTaskQuery("github", " is:open label:devintern ")).toBe(true);
    expect(defaultQueryZeroMatchHint("github", "is:open label:devintern")).toContain(
      "add the devintern label to an open issue",
    );
    expect(defaultQueryZeroMatchHint("github", "is:open label:bug")).toBeUndefined();
    expect(defaultQueryZeroMatchHint("markdown", "status=todo")).toBeUndefined();
  });
});

describe("parseNonInteractiveInitArgs --create-label", () => {
  test("parses the flag, which re-run commands keep", () => {
    const parsed = parseNonInteractiveInitArgs(["--tracker", "github", "--create-label"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.createLabel).toBe(true);
    expect(parsed.args.taskQuery).toBeUndefined();
    const rerun = initRerunCommand(parsed.args, { cwd: "/tmp", workspaceDir: "/tmp/ws" });
    expect(rerun).toContain("--create-label");
    expect(rerun).not.toContain("--task-query");
  });
});

describe("worker init --non-interactive default query", () => {
  let root: string;
  let workspaceDir: string;
  let repoDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "worker-default-query-"));
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
      { repoFromCwd: false, json: true, yes: false, ...args },
      {
        cwd: repoDir,
        workspaceDir,
        home: root,
        processEnv: { ...GITHUB_ENV },
        probe: async () => {},
        probeTimeoutMs: 2_000,
        which: () => null,
        doctor: doctorStubs(doctorOverrides),
        devinternLabelOps: labelStub(true).factory,
        ...rest,
      },
    );
  }

  test("a new workspace without --task-query uses the tracker's default", async () => {
    const report = await run({ tracker: "github" });
    expect(report.error).toBeUndefined();
    expect(report.result).toBe("success");
    expect(report.taskQuery).toBe("is:open label:devintern");
    const config = loadWorkspaceConfig(join(workspaceDir, "workspace.toml"));
    expect(config.defaults.taskQuery).toBe("is:open label:devintern");
    expect(report.checks.find((check) => check.name === "label")?.status).toBe("pass");
  });

  test("an explicit --task-query overrides the default and skips the label check", async () => {
    const label = labelStub(false);
    const report = await run(
      { tracker: "github", taskQuery: "is:open assignee:@me" },
      { devinternLabelOps: label.factory },
    );
    expect(report.result).toBe("success");
    expect(report.taskQuery).toBe("is:open assignee:@me");
    expect(label.calls).toEqual({ exists: 0, create: 0 });
    expect(report.checks.some((check) => check.name === "label")).toBe(false);
  });

  test("a saved query is kept instead of the default", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      '[defaults]\ntracker = "github"\ntask_query = "is:open label:ready"\n',
    );
    const report = await run({ tracker: "github", yes: true });
    expect(report.taskQuery).toBe("is:open label:ready");
    const config = loadWorkspaceConfig(join(workspaceDir, "workspace.toml"));
    expect(config.defaults.taskQuery).toBe("is:open label:ready");
  });

  test("a missing label warns without --create-label and is never created", async () => {
    const label = labelStub(false);
    const report = await run({ tracker: "github" }, { devinternLabelOps: label.factory });
    expect(report.result).toBe("success");
    expect(label.calls).toEqual({ exists: 1, create: 0 });
    expect(report.labelCreated).toBeUndefined();
    const row = report.checks.find((check) => check.name === "label");
    expect(row?.status).toBe("warn");
    expect(row?.hint).toContain("--create-label");
  });

  test("--create-label creates a missing label", async () => {
    const label = labelStub(false);
    const report = await run(
      { tracker: "github", createLabel: true },
      { devinternLabelOps: label.factory },
    );
    expect(report.result).toBe("success");
    expect(label.calls).toEqual({ exists: 1, create: 1 });
    expect(report.labelCreated).toBe(true);
    expect(report.checks.find((check) => check.name === "label")?.status).toBe("pass");
  });

  test("--create-label leaves an existing label alone", async () => {
    const label = labelStub(true);
    const report = await run(
      { tracker: "github", createLabel: true },
      { devinternLabelOps: label.factory },
    );
    expect(label.calls).toEqual({ exists: 1, create: 0 });
    expect(report.labelCreated).toBeUndefined();
  });

  test("a label the token cannot create warns and keeps the setup", async () => {
    const label = labelStub(false, new Error("GitHub API error (403): Resource not accessible"));
    const report = await run(
      { tracker: "github", createLabel: true },
      { devinternLabelOps: label.factory },
    );
    expect(report.result).toBe("success");
    expect(report.persisted).toBe(true);
    const row = report.checks.find((check) => check.name === "label");
    expect(row?.status).toBe("warn");
    expect(row?.message).toContain("could not create");
  });

  test("--create-label on a tracker without a label API is reported as skipped", async () => {
    const report = await run(
      { tracker: "jira", createLabel: true },
      { processEnv: { ...JIRA_ENV } },
    );
    expect(report.result).toBe("success");
    expect(report.taskQuery).toStartWith("labels = devintern");
    expect(report.checks.find((check) => check.name === "label")?.status).toBe("skipped");
  });

  test("0 matches for the default query says how to label a ticket", async () => {
    const report = await run(
      { tracker: "github" },
      { doctorOverrides: { dryRunQuery: async () => 0 } },
    );
    const query = report.checks.find((check) => check.name === "query");
    expect(query?.status).toBe("warn");
    expect(query?.hint).toContain("No open ticket is labeled devintern yet");
  });

  test("trackers without a default still report missing_input", async () => {
    const report = await run(
      { tracker: "asana" },
      { processEnv: { ASANA_API_TOKEN: "x".repeat(20) } },
    );
    expect(report.code).toBe("missing_input");
    expect(report.missing).toEqual(["--task-query"]);
  });
});
