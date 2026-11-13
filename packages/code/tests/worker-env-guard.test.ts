import { describe, expect, test } from "bun:test";

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

  test("drops worker state but keeps unrelated and pinned variables", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      KEEP_ME: "1",
      WEBHOOK_QUEUE_DB: "/tmp/queue.db",
      DEVINTERN_WORKSPACE_DIR: "/tmp/workspace",
    };
    for (const name of WORKER_INJECTED_ENV_VARS) env[name] = "leaked";

    stripWorkerInjectedEnv(env);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.KEEP_ME).toBe("1");
    // Pins applied by the other guards are not in the worker set.
    expect(env.WEBHOOK_QUEUE_DB).toBe("/tmp/queue.db");
    expect(env.DEVINTERN_WORKSPACE_DIR).toBe("/tmp/workspace");
    for (const name of WORKER_INJECTED_ENV_VARS) {
      expect(env[name]).toBeUndefined();
    }
  });
});
