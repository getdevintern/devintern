import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const existingCeilings = process.env.GIT_CEILING_DIRECTORIES;
const gitCeilingDirectories = [resolve(tmpdir()), existingCeilings]
  .filter((value): value is string => Boolean(value))
  .join(delimiter);

// Give every bun test child a safe WEBHOOK_QUEUE_DB in its process-start
// environment. The per-file guard (tests/setup/guard-queue-db.ts) re-pins it
// for in-process code, but Bun children spawned WITHOUT an explicit env option
// inherit the environment captured when the test process started, so the pin
// has to exist before that too — otherwise such children could fall back to a
// developer's real .devintern-code/queue.db if their cwd sits inside a
// configured project tree.
//
// DEVINTERN_WORKSPACE_DIR is pinned for the same reason (guard-workspace-dir.ts
// re-pins it per test process): a test-spawned CLI with a stub agent would
// otherwise write harness run logs and other workspace state into the
// developer's real ~/.devintern.
//
// SENTRY_DISABLED is pinned for the same reason (guard-sentry.ts re-pins it in
// each test process): test-spawned CLI subprocesses must never report events
// to the baked-in production Sentry DSN (DEVINTERN-7).
const queueDbTempDir = mkdtempSync(join(tmpdir(), "devintern-test-state-"));
process.on("exit", () => {
  try {
    rmSync(queueDbTempDir, { recursive: true, force: true });
  } catch {
    // Best effort: leftover temp state under the OS tmpdir is harmless.
  }
});

// Ambient prompt overrides make prompt-rendering tests non-hermetic: a
// developer's DEVINTERN_PROMPTS_DIR (or an ancestor `.devintern-code/prompts/`)
// would silently change their results. Drop the variable from the child
// environment so the bundled catalog is the default for the whole run; tests
// that exercise overrides pass explicit `overrideDirs` instead.
const childEnv = { ...process.env };
delete childEnv.DEVINTERN_PROMPTS_DIR;

// A developer's agent configuration must not leak into the suite either:
// DEVINTERN_HARNESS_CHAIN changes which harness counts as primary (suppressing
// AGENT_MODEL), and *_CLI_PATH / DSH_HOME can point tests at tools and state
// outside the isolated temp directories. Tests that need a harness configure it
// explicitly.
for (const key of Object.keys(childEnv)) {
  if (key.endsWith("_CLI_PATH") || key.endsWith("_MODEL")) {
    delete childEnv[key];
  }
}
for (const key of [
  "AGENT_HARNESS",
  "DEVINTERN_HARNESS_CHAIN",
  "AGENT_MODEL",
  "AGENT_EFFORT",
  "DSH_HOME",
]) {
  delete childEnv[key];
}

// DevIntern's own worker runtime must not leak into the suite. The worker
// marker makes the CLI skip project `.env` loading and makes workspace
// credential lookup return null, while the webhook auto-review variables
// override the startup iteration cap. Both hide real regressions when the
// suite is run from a worker checkout.
for (const key of [
  "DEVINTERN_WORKER_SUBPROCESS",
  "DEVINTERN_WORKER_CHILD",
  "DEVINTERN_WORKSPACE_REPO",
  "DEVINTERN_WORKSPACE_TEAM",
  "DEVINTERN_WORKSPACE_PIPELINE_REPO",
  "DEVINTERN_RUN_ORIGIN",
  "DEVINTERN_ACTIONED_SOURCE",
  "DEVINTERN_USAGE_LIMIT_FILE",
  "WEBHOOK_AUTO_REVIEW",
  "WEBHOOK_AUTO_REVIEW_MAX_ITERATIONS",
]) {
  delete childEnv[key];
}

const child = Bun.spawn(["bun", "test", "--timeout=30000", ...process.argv.slice(2)], {
  cwd: import.meta.dir,
  env: {
    ...childEnv,
    GIT_CEILING_DIRECTORIES: gitCeilingDirectories,
    WEBHOOK_QUEUE_DB: join(queueDbTempDir, "queue.db"),
    DEVINTERN_WORKSPACE_DIR: join(queueDbTempDir, "workspace"),
    SENTRY_DISABLED: "1",
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await child.exited);
