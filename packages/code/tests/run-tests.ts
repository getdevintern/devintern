import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { GUARD_FILES } from "./setup/guard-files";
import { mutatingServiceCalls, SERVICE_MANAGER_COMMANDS } from "./setup/service-stubs";
import { normalizeTestArgs } from "./setup/test-args";
import { stripWorkerInjectedEnv } from "./setup/worker-env";

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

// Service-manager commands resolve through PATH, so shadow them with stubs
// that never reach the real systemd/launchd. The service unit name is fixed
// (`devintern-worker`), so a test that fakes `homedir` but forgets to inject
// `run` would otherwise `systemctl --user restart` the developer's live worker
// — and, when the suite runs inside a worker task, kill every running task.
// Each stub logs its call and fails; a state-changing call fails the suite.
const serviceStubDir = join(queueDbTempDir, "service-stubs");
const serviceStubLog = join(queueDbTempDir, "service-stub-calls.log");
mkdirSync(serviceStubDir, { recursive: true });
for (const command of SERVICE_MANAGER_COMMANDS) {
  const stub = join(serviceStubDir, command);
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "${command} $*" >> ${JSON.stringify(serviceStubLog)}\n` +
      `echo "${command} is stubbed in tests; inject a run function instead" >&2\nexit 1\n`,
  );
  chmodSync(stub, 0o755);
}

// Ambient prompt overrides make prompt-rendering tests non-hermetic: a
// developer's DEVINTERN_PROMPTS_DIR would silently change their results. The same applies to the rest of the
// worker-injected environment when an agent runs the suite from inside a
// worker task subprocess, so strip the whole set from the child environment
// and let the per-file guard handle in-process code.
const childEnv = { ...process.env };
stripWorkerInjectedEnv(childEnv);

// Bun only reads bunfig.toml from the process cwd, and the inner Bun runs with
// cwd=tests/, so packages/code/bunfig.toml (the file that lists the guards) is
// never discovered here. Pass the same guards explicitly, otherwise the guard
// chain is inert in the normal `bun run test` path: the env pins below keep the
// suite safe, but guard-git-state's process.chdir ban and guard-queue-db's
// tamper detection would never load, and dropping a guard from bunfig.toml
// would go unnoticed.
const GUARD_PRELOADS = GUARD_FILES.flatMap((name) => [
  "--preload",
  join(import.meta.dir, "setup", name),
]);

// The inner Bun resolves path arguments against tests/, so a package-relative
// path such as `tests/foo.test.ts` would match nothing. Rewrite paths that
// exist relative to the invoking directory into tests/-relative ones.
const testArgs = normalizeTestArgs(process.argv.slice(2), process.cwd(), import.meta.dir);

const child = Bun.spawn(["bun", "test", "--timeout=30000", ...GUARD_PRELOADS, ...testArgs], {
  cwd: import.meta.dir,
  env: {
    ...childEnv,
    PATH: [serviceStubDir, childEnv.PATH].filter(Boolean).join(delimiter),
    GIT_CEILING_DIRECTORIES: gitCeilingDirectories,
    WEBHOOK_QUEUE_DB: join(queueDbTempDir, "queue.db"),
    DEVINTERN_WORKSPACE_DIR: join(queueDbTempDir, "workspace"),
    SENTRY_DISABLED: "1",
    // Test dashboards never shell out to the developer's real `tailscale`.
    DASHBOARD_TAILSCALE_AUTODETECT: "0",
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await child.exited;
const calls = existsSync(serviceStubLog) ? readFileSync(serviceStubLog, "utf8") : "";
const mutating = mutatingServiceCalls(calls);
if (mutating.length > 0) {
  console.error(
    "\n❌ Tests ran state-changing service-manager commands (stubbed, so nothing reached the real " +
      "service). Inject `run` into the service code instead:\n" +
      mutating.map((call) => `   ${call}`).join("\n"),
  );
  process.exit(exitCode === 0 ? 1 : exitCode);
}
process.exit(exitCode);
