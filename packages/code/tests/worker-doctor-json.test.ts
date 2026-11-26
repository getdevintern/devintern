import { describe, expect, test } from "bun:test";

import type { ReadinessCheck } from "../src/lib/observability/readiness";
import {
  buildWorkerDoctorReport,
  readinessExitCode,
  WORKER_DOCTOR_JSON_SCHEMA,
} from "../src/lib/observability/readiness-json";

const options = { workspaceDir: "/home/u/.devintern", offline: false, env: {}, home: "/home/u" };
const ok = (id: string, label = id): ReadinessCheck => ({
  id,
  label,
  status: "ok",
  detail: "fine",
});

describe("buildWorkerDoctorReport", () => {
  test("ready: success, exit 0, checks use the init shape, the service is offered", () => {
    const report = buildWorkerDoctorReport([ok("repo", "Repository access")], options);
    expect(report).toMatchObject({
      schema: WORKER_DOCTOR_JSON_SCHEMA,
      version: 1,
      result: "success",
      workspaceDir: "/home/u/.devintern",
      offline: false,
      checks: [{ name: "repo", label: "Repository access", status: "pass", message: "fine" }],
    });
    expect(readinessExitCode(report.result)).toBe(0);
    expect(report.setup).toBe("ready");
    // Only the background service: a foreground `devintern worker` would block an agent.
    expect(report.nextSteps).toEqual([
      {
        id: "service",
        message: expect.stringContaining("background service"),
        command: "devintern worker service install --json",
      },
    ]);
  });

  test("a running worker gets no start step and setup: complete", () => {
    const report = buildWorkerDoctorReport(
      [{ ...ok("worker", "Worker"), detail: "running (pid 42)" }],
      options,
    );
    expect(report.nextSteps).toEqual([]);
    expect(report.setup).toBe("complete");
    expect(report.summary).toBe("every check passed and the worker is running (pid 42).");
  });

  test("only sign-in left: action_required, exit 2, runnable sign-in command", () => {
    const report = buildWorkerDoctorReport(
      [
        {
          id: "entitlement",
          label: "Automation entitlement",
          status: "action",
          detail: "Not started",
          hint: "Run it",
        },
      ],
      options,
    );
    expect(report.result).toBe("action_required");
    expect(readinessExitCode(report.result)).toBe(2);
    expect(report.checks[0]).toMatchObject({ status: "action", hint: "Run it" });
    expect(report.nextSteps).toHaveLength(1);
    expect(report.nextSteps[0]).toMatchObject({
      id: "sign-in",
      command: "devintern worker login github --no-wait --json",
    });
    expect(report.setup).toBe("action_required");
    expect(report.code).toBeUndefined();
  });

  test("a failed harness is a failure (exit 1) with install-agent and no start or service", () => {
    const report = buildWorkerDoctorReport(
      [
        { id: "harness", label: "Agent harness", status: "fail", detail: "missing" },
        { id: "repo", label: "Repository access", status: "warn", detail: "slow" },
      ],
      { ...options, env: { AGENT_HARNESS: "codex" }, which: () => "/usr/bin/npm" },
    );
    expect(report.result).toBe("failure");
    expect(readinessExitCode(report.result)).toBe(1);
    expect(report.code).toBe("agent_missing");
    expect(report.setup).toBe("not_ready");
    expect(report.nextSteps.map((step) => step.id)).toEqual(["install-agent"]);
    expect(report.nextSteps[0]?.command).toBe("npm install -g @openai/codex");
  });

  test("failures get check-specific fixes, not `worker doctor`", () => {
    const report = buildWorkerDoctorReport(
      [
        { id: "query", label: "Task query", status: "fail", detail: "bad JQL", hint: "Fix it" },
        {
          id: "credentials",
          label: "Tracker credentials",
          status: "fail",
          detail: "jira: 401",
        },
        {
          id: "repo",
          label: "Repository access",
          status: "fail",
          detail: "GITHUB_TOKEN can read acme/app but cannot push",
        },
      ],
      options,
    );
    expect(report.code).toBe("query_rejected");
    expect(report.nextSteps).toEqual([
      {
        id: "fix-query",
        message: "Task query: bad JQL. Fix it. Re-run setup with a query the tracker accepts",
        command: "devintern worker init --non-interactive --yes --task-query '<query>' --json",
      },
      {
        id: "fix-credentials",
        message: expect.stringContaining("Tracker credentials: jira: 401"),
        command: "devintern worker init --non-interactive --yes --env-file <path> --json",
      },
      {
        id: "fix-repo-access",
        message: expect.stringContaining("Contents and Pull requests read and write"),
        command: "https://github.com/settings/personal-access-tokens",
        url: "https://github.com/settings/personal-access-tokens",
      },
    ]);
    for (const step of report.nextSteps) expect(step.command).not.toBe("devintern worker doctor");
  });

  test("a non-default workspace names itself in every command", () => {
    const report = buildWorkerDoctorReport(
      [
        {
          id: "entitlement",
          label: "Automation entitlement",
          status: "action",
          detail: "Not started",
        },
      ],
      { ...options, workspaceDir: "/srv/ws" },
    );
    expect(report.nextSteps[0]?.command).toBe(
      "devintern worker login --workspace /srv/ws/workspace.toml github --no-wait --json",
    );
    const ready = buildWorkerDoctorReport([ok("repo")], { ...options, workspaceDir: "/srv/ws" });
    expect(ready.nextSteps[0]?.command).toBe(
      "DEVINTERN_WORKSPACE_DIR=/srv/ws devintern worker service install --json",
    );
  });
});
