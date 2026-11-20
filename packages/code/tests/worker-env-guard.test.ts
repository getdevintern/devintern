import { describe, expect, test } from "bun:test";

import { MAX_CONCURRENCY_PER_REPO_ENV } from "../src/lib/utils/review-worktree";
import { stripWorkerInjectedEnv, WORKER_INJECTED_ENV_VARS } from "./setup/worker-env";

describe("stripWorkerInjectedEnv", () => {
  test("removes the worker-injected variables the triage run reproduced", () => {
    // Regression: `bun test` launched from inside a worker task subprocess
    // inherited these and failed analysis-mode, workspace-manual-credentials,
    // and cli suites.
    expect(WORKER_INJECTED_ENV_VARS).toContain("DEVINTERN_WORKER_SUBPROCESS");
    expect(WORKER_INJECTED_ENV_VARS).toContain("DEVINTERN_WORKSPACE_PIPELINE_REPO");
    expect(WORKER_INJECTED_ENV_VARS).toContain("DEVINTERN_HARNESS_CHAIN");
  });

  test("strips the per-repo concurrency cap PR jobs inherit", () => {
    // Regression: agents running the suite inside a worker PR job inherited
    // DEVINTERN_MAX_CONCURRENCY_PER_REPO=8, which raised the idle-worktree cap
    // webhook-integration expects to be the default.
    expect(WORKER_INJECTED_ENV_VARS).toContain(MAX_CONCURRENCY_PER_REPO_ENV);
    const env: NodeJS.ProcessEnv = { [MAX_CONCURRENCY_PER_REPO_ENV]: "8" };
    stripWorkerInjectedEnv(env);
    expect(env[MAX_CONCURRENCY_PER_REPO_ENV]).toBeUndefined();
  });

  test("drops worker state but keeps unrelated and pinned variables", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      KEEP_ME: "1",
      WEBHOOK_QUEUE_DB: "/tmp/queue.db",
      DEVINTERN_WORKSPACE_DIR: "/tmp/workspace",
      SENTRY_DISABLED: "1",
    };
    for (const name of WORKER_INJECTED_ENV_VARS) env[name] = "leaked";

    stripWorkerInjectedEnv(env);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.KEEP_ME).toBe("1");
    // Pins applied by the other guards are not in the worker set.
    expect(env.WEBHOOK_QUEUE_DB).toBe("/tmp/queue.db");
    expect(env.DEVINTERN_WORKSPACE_DIR).toBe("/tmp/workspace");
    expect(env.SENTRY_DISABLED).toBe("1");
    for (const name of WORKER_INJECTED_ENV_VARS) {
      expect(env[name]).toBeUndefined();
    }
  });
});
