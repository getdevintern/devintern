/**
 * Worker-injected environment variables the test suite must not inherit.
 *
 * Agents often run `bun test` from inside a DevIntern worker task subprocess.
 * That process carries the worker runtime markers and the routed task's
 * workspace layers (`DEVINTERN_WORKER_SUBPROCESS`, the pipeline override, the
 * harness chain, …), which change config-dir resolution, pipeline selection,
 * and harness resolution. Inheriting them made unrelated suites fail
 * (`analysis-mode`, `workspace-manual-credentials`, `cli`) even though the
 * code under test was unchanged.
 *
 * Beyond routing, the worker also hands each task subprocess run markers
 * (origin, automation id, queue claim, pickup/stack state), parent-child
 * protocol channels (usage-limit and run-outcome hint files, the review result
 * fd, the harness log run id), and runtime limits such as the per-repo
 * concurrency cap PR jobs use to size idle review worktrees. Inherited, these
 * change test-visible defaults (run identity, idle-worktree cap, auth mode) or
 * make test-spawned CLIs write into the live worker's hint files.
 *
 * Tests that need any of these values set them explicitly for the code they
 * exercise; the suite-level default must stay neutral.
 */
export const WORKER_INJECTED_ENV_VARS = [
  "DEVINTERN_PROMPTS_DIR",
  "DEVINTERN_WORKER_SUBPROCESS",
  "DEVINTERN_WORKER_TRIAL",
  "DEVINTERN_WORKSPACE_REPO",
  "DEVINTERN_WORKSPACE_TEAM",
  "DEVINTERN_WORKSPACE_PIPELINE_REPO",
  "DEVINTERN_WORKSPACE_PIPELINE_DEFAULT",
  "DEVINTERN_ACTIONED_SOURCE",
  "DEVINTERN_HARNESS_CHAIN",
  // Runtime limits and auth policy (fleet-events.ts, fleet-event-acquirers.ts).
  "DEVINTERN_MAX_CONCURRENCY_PER_REPO",
  "DEVINTERN_GITHUB_AUTH_MODE",
  "DEVINTERN_ANALYTICS_CONFIG_DIR",
  // Run markers (fleet-executor.ts, automation acquirers).
  "DEVINTERN_RUN_ORIGIN",
  "DEVINTERN_AUTOMATION_ID",
  "DEVINTERN_QUEUE_CLAIM",
  "DEVINTERN_STACKED_ON",
  "DEVINTERN_PICKUP_RUN_ID",
  "DEVINTERN_INJECTED_CREATED_AT",
  // Parent-child protocol channels (failover, automation, review/auto-merge CLIs).
  "DEVINTERN_WORKER_CHILD",
  "DEVINTERN_USAGE_LIMIT_FILE",
  "DEVINTERN_RUN_OUTCOME_FILE",
  "DEVINTERN_RESULT_FD",
  "DEVINTERN_HARNESS_LOG_RUN_ID",
] as const;

/**
 * Delete every worker-injected variable from `env` in place.
 *
 * Used by the per-file guard (in-process code) and by `tests/run-tests.ts`
 * (CLI subprocesses spawned without an explicit env). Pins applied afterwards
 * (`WEBHOOK_QUEUE_DB`, `DEVINTERN_WORKSPACE_DIR`, `SENTRY_DISABLED`) are not in
 * this list, so they survive.
 *
 * @param env - Environment object to sanitize (defaults to `process.env`).
 */
export function stripWorkerInjectedEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of WORKER_INJECTED_ENV_VARS) {
    delete env[name];
  }
}
