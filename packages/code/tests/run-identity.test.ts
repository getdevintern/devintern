import { describe, expect, test } from "bun:test";

import { resolveRunIdentity } from "../src/lib/task/run-identity";
import { RUN_ORIGIN_ENV } from "../src/lib/observability/analytics";
import { WORKSPACE_REPO_ENV, WORKSPACE_TEAM_ENV } from "../src/lib/workspace/env";

describe("resolveRunIdentity", () => {
  test("records a plain task against the ambient tracker", () => {
    expect(resolveRunIdentity({ TASK_TRACKER: "jira" })).toEqual({
      origin: "task",
      tracker: "jira",
      team: undefined,
      repo: undefined,
    });
  });

  test("maps local injected runs to the recovery scope", () => {
    expect(
      resolveRunIdentity({
        [RUN_ORIGIN_ENV]: "local",
        [WORKSPACE_REPO_ENV]: "backend",
        TASK_TRACKER: "jira",
      }),
    ).toEqual({
      origin: "local",
      tracker: "local",
      team: undefined,
      repo: "backend",
    });
  });

  test("keeps the origin-marker tracker when an automation id wins the origin", () => {
    // Historical behavior: an automation marker decides `origin`, but a local
    // or Sentry origin marker still attributes the run to its own tracker.
    expect(
      resolveRunIdentity({
        DEVINTERN_AUTOMATION_ID: "nightly",
        [RUN_ORIGIN_ENV]: "error_monitor",
        TASK_TRACKER: "jira",
      }),
    ).toEqual({
      origin: "scheduled",
      tracker: "sentry",
      team: undefined,
      repo: undefined,
      automationId: "nightly",
    });
  });

  test("distinguishes manual automation runs and carries team context", () => {
    expect(
      resolveRunIdentity({
        DEVINTERN_AUTOMATION_ID: "nightly",
        [RUN_ORIGIN_ENV]: "manual",
        [WORKSPACE_TEAM_ENV]: "platform",
        [WORKSPACE_REPO_ENV]: "api",
      }),
    ).toEqual({
      origin: "manual",
      tracker: "jira",
      team: "platform",
      repo: "api",
      automationId: "nightly",
    });
  });
});
