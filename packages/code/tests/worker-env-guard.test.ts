import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUN_ID_ENV, RUN_OUTPUTS_ENV } from "../src/lib/state/run-outputs";
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

  test("strips the agent harness the worker routed the task to", () => {
    // Regression: the suite inherited AGENT_HARNESS=opencode, so a workflow
    // that expects the default harness got OpenCode's install hint instead.
    expect(WORKER_INJECTED_ENV_VARS).toContain("AGENT_HARNESS");
    const env: NodeJS.ProcessEnv = { AGENT_HARNESS: "opencode" };
    stripWorkerInjectedEnv(env);
    expect(env.AGENT_HARNESS).toBeUndefined();
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

/**
 * Probe test that does what `devintern worker add` does without an injected
 * env: append an `injected_task` record to the outputs file when the
 * surrounding run is visible in `process.env`.
 */
const LINEAGE_PROBE_TEST = `import { appendFileSync } from "node:fs";
import { test } from "bun:test";

test("worker add style lineage probe", () => {
  const outputs = process.env.${RUN_OUTPUTS_ENV};
  if (process.env.${RUN_ID_ENV} && outputs) {
    appendFileSync(outputs, JSON.stringify({ v: 1, kind: "injected_task", taskKey: "local-base" }));
  }
});
`;

describe("run lineage channel", () => {
  test("is in the stripped set", () => {
    expect(WORKER_INJECTED_ENV_VARS).toContain(RUN_ID_ENV);
    expect(WORKER_INJECTED_ENV_VARS).toContain(RUN_OUTPUTS_ENV);
    const env: NodeJS.ProcessEnv = { [RUN_ID_ENV]: "999", [RUN_OUTPUTS_ENV]: "/tmp/999.jsonl" };
    stripWorkerInjectedEnv(env);
    expect(env[RUN_ID_ENV]).toBeUndefined();
    expect(env[RUN_OUTPUTS_ENV]).toBeUndefined();
  });

  test("a test process started inside an agent run cannot append to its outputs", async () => {
    // Regression: worker-add tests appended 43 fixture tasks to the live run's
    // outputs file, which surfaced as "Run #N delegated 43 tasks".
    const dir = mkdtempSync(join(tmpdir(), "run-lineage-guard-"));
    const outputs = join(dir, "999.jsonl");
    const probe = join(dir, "lineage.test.ts");
    writeFileSync(probe, LINEAGE_PROBE_TEST);
    try {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      env[RUN_ID_ENV] = "999";
      env[RUN_OUTPUTS_ENV] = outputs;
      // A probe outside the repo keeps the child Bun from discovering this suite.
      const guard = join(import.meta.dir, "setup", "guard-worker-env.ts");
      const proc = Bun.spawn(["bun", "test", "--preload", guard, probe], {
        cwd: dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [output, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(output).toContain("1 pass");
      expect(exitCode).toBe(0);
      expect(existsSync(outputs) ? readFileSync(outputs, "utf8") : "").toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
