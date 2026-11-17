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
