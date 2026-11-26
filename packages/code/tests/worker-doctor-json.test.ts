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
  test("ready: success, exit 0, checks use the init shape, start and service offered", () => {
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
    expect(report.nextSteps.map((step) => step.id)).toEqual(["start", "service"]);
  });

  test("a running worker gets no start step", () => {
    const report = buildWorkerDoctorReport([ok("worker")], options);
    expect(report.nextSteps).toEqual([]);
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
  });

  test("a failed harness is a failure (exit 1) with install-agent and no start or service", () => {
    const report = buildWorkerDoctorReport(
      [
        { id: "harness", label: "Agent harness", status: "fail", detail: "missing" },
        { id: "repo", label: "Repository access", status: "warn", detail: "slow" },
      ],
      { ...options, env: { AGENT_HARNESS: "codex" } },
    );
    expect(report.result).toBe("failure");
    expect(readinessExitCode(report.result)).toBe(1);
    expect(report.nextSteps.map((step) => step.id)).toEqual(["install-agent"]);
    expect(report.nextSteps[0]?.command).toBe("npm install -g @openai/codex");
  });

  test("other failures name the row in message and point at worker doctor", () => {
    const report = buildWorkerDoctorReport(
      [{ id: "query", label: "Task query", status: "fail", detail: "bad JQL", hint: "Fix it" }],
      options,
    );
    expect(report.nextSteps).toEqual([
      {
        id: "fix",
        message: "Task query: bad JQL. Fix it",
        command: "devintern worker doctor",
      },
    ]);
  });
});
