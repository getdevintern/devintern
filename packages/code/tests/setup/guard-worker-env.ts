/**
 * Test setup guard — preloaded before every test via `bunfig.toml`.
 *
 * Drops worker-injected runtime variables from this test-file process. Agents
 * commonly run `bun test` from inside a DevIntern worker task subprocess, which
 * exports `DEVINTERN_WORKER_SUBPROCESS`, the routed pipeline override, and the
 * harness chain. Those change config-dir resolution, pipeline selection, and
 * harness resolution, so suites failed depending on where the tests were run.
 *
 * `tests/run-tests.ts` strips the same list from the child environment so CLI
 * subprocesses spawned without an explicit env are neutral too. Tests that
 * exercise the variables set them themselves and restore afterwards.
 */

import { stripWorkerInjectedEnv } from "./worker-env";

stripWorkerInjectedEnv(process.env);

// Dashboard servers started by tests must not shell out to the developer's
// real `tailscale` (Serve auto-detection) or inherit a shell's allowlist.
// Tests that exercise detection inject a probe and re-enable it explicitly.
process.env.DASHBOARD_TAILSCALE_AUTODETECT = "0";
delete process.env.DASHBOARD_ALLOWED_ORIGINS;
