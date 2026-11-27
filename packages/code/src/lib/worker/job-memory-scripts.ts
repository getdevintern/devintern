/**
 * Scripts the job-memory launcher runs: the in-scope OOM shim and the
 * `systemd-run` wrapper that falls back to an unwrapped run.
 *
 * Kept out of `job-memory.ts` (whose size limit the launcher would otherwise
 * exceed) and free of imports so the strings stay easy to read and test.
 */

/**
 * Shim script run inside the scope. It is written to a file rather than passed
 * through `systemd-run`'s argv: systemd expands `$VAR` / `${VAR}` in ExecStart
 * arguments, which would mangle the shell variables below.
 *
 * The command runs in the foreground so it keeps the parent's stdio (including
 * the `DEVINTERN_RESULT_FD` channel) and stdin. After it exits, the shim reads
 * the scope's `memory.events`; the counter survives until the scope is
 * unloaded, which happens after the shim exits, so this read is not racy.
 */
export const OOM_SHIM = `#!/bin/sh
# Tell the launcher that the scope command actually started. Without this
# marker a systemd-run failure before exec is retried unwrapped instead of
# being mistaken for the job's own exit status.
[ -n "$DEVINTERN_JOB_MEMORY_STARTED" ] && printf '1\\n' > "$DEVINTERN_JOB_MEMORY_STARTED" 2>/dev/null
# Scope teardown sends SIGTERM as soon as the runaway is killed; catch it so
# this process can read the scope's OOM counter before the cgroup disappears.
# (A caught trap, not an ignored signal, so the command keeps the default
# SIGTERM disposition and the worker's drain still stops it gracefully.)
trap ':' TERM
"$@"
status=$?
cg=$(cat /proc/self/cgroup 2>/dev/null)
cg=\${cg#0::}
if grep -Eq '^oom_kill [1-9][0-9]*$' "/sys/fs/cgroup\${cg}/memory.events" 2>/dev/null; then
  printf '1\\n' > "$DEVINTERN_JOB_MEMORY_MARKER" 2>/dev/null
fi
exit "$status"
`;

/**
 * Launcher around `systemd-run` that retries the command unwrapped when the
 * scope never starts.
 *
 * `systemd-run --user --scope` can fail before exec (a restarted user manager,
 * a bad `XDG_RUNTIME_DIR`, a bad property). Treating that exit status as the
 * job's own result would fail every job while the 5-minute support cache still
 * said scopes work. The shim writes a started marker as its first action; if
 * it is absent after a non-zero `systemd-run` exit, the scope never ran the
 * command, so this reruns it without a limit for this attempt.
 *
 * A file-based argv keeps prompts byte-for-byte intact (no shell quoting in
 * the fallback path).
 */
export const SCOPE_LAUNCHER = `const { spawn } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const signals = require("node:os").constants.signals;
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));

function stdio() {
  return ["inherit", "inherit", "inherit", process.env.DEVINTERN_RESULT_FD ? "inherit" : "ignore"];
}

function exitFor(code, signal) {
  process.exit(code === null ? 128 + (signals[signal] || 0) : code);
}

function start(command, args, env, onDone) {
  let child;
  let settled = false;
  const finish = (code, signal, error) => {
    if (settled) return;
    settled = true;
    onDone(code, signal, error);
  };
  try {
    child = spawn(command, args, { stdio: stdio(), ...(env ? { env } : {}) });
  } catch (error) {
    finish(null, null, error);
    return;
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // The child may already have exited.
      }
    });
  }
  child.on("error", (error) => finish(null, null, error));
  child.on("close", (code, signal) => finish(code, signal, null));
}

const jobMemoryEnv = [
  "DEVINTERN_JOB_MEMORY_LIMIT_LABEL",
  "DEVINTERN_JOB_MEMORY_MARKER",
  "DEVINTERN_JOB_MEMORY_STARTED",
  "DEVINTERN_JOB_MEMORY_FALLBACK",
];

function runUnwrapped() {
  writeFileSync(spec.fallback, "1\\n");
  // No scope means no cap: drop the scope markers so the child does not read
  // (and blame) the launcher's own cgroup for an unrelated OOM kill.
  const env = { ...process.env };
  for (const name of jobMemoryEnv) delete env[name];
  start(spec.command, spec.args, env, (code, signal, error) => {
    if (error) process.exit(127);
    exitFor(code, signal);
  });
}

start(spec.systemd[0], spec.systemd.slice(1), undefined, (code, signal, error) => {
  if (error) {
    runUnwrapped();
    return;
  }
  // A signal means the worker is draining (or killing) the job; never rerun it.
  if (signal === null && code !== 0 && !existsSync(spec.started)) {
    runUnwrapped();
    return;
  }
  exitFor(code, signal);
});
`;
