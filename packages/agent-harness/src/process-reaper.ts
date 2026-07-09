/**
 * Process-group reaper.
 *
 * Agent CLIs frequently spawn long-lived grandchildren — dev servers, watch
 * builds, `vite`, `uvicorn`, `docker compose up` — to verify their changes, and
 * routinely leave them running. Killing only the agent process orphans those
 * grandchildren: they keep running after the harness exits and, under scheduled
 * automation (systemd timers, cron), accumulate across every run.
 *
 * {@link spawnReapable} starts the child in its own process group (`detached`),
 * so the entire group can be torn down at once with {@link reapTree}. Every live
 * group is also tracked module-side and SIGTERM'd when the parent process exits,
 * so a normal finish, Ctrl-C, `systemctl stop`, or a closed terminal all clean
 * up whatever the agent left running.
 *
 * Portable across Linux and macOS — `detached` issues `setsid(2)` on both. The
 * one gap is a grandchild that calls `setsid()` itself (true daemonization): it
 * escapes the group. On Linux a systemd unit's cgroup reaps those as a backstop
 * (see `KillMode=control-group`, the default); see the server-automation docs.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "child_process";

/** PGIDs of process groups spawned via {@link spawnReapable} that are still alive. */
const trackedGroups = new Set<number>();
let handlersInstalled = false;

/** SIGNAL every tracked, still-running group. Best-effort: a missing group is fine. */
function reapAllGroups(signal: NodeJS.Signals): void {
  for (const pgid of trackedGroups) {
    try {
      // Negative PID targets the whole process group.
      process.kill(-pgid, signal);
    } catch {
      // Group already exited; nothing to reap.
    }
  }
}

/**
 * Install the parent-process cleanup handlers exactly once.
 *
 * `exit` fires on every `process.exit()` path — normal completion, error exits,
 * and the SIGINT/SIGTERM handlers callers typically register that call
 * `process.exit()`. It is synchronous-only, so we send a single SIGTERM to each
 * surviving group (enough for dev servers; we don't get to wait and escalate).
 *
 * SIGHUP (e.g. a closed terminal) has no default handler that reaches `exit`, so
 * it gets its own listener.
 */
function installExitHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.on("exit", () => reapAllGroups("SIGTERM"));
  process.on("SIGHUP", () => {
    reapAllGroups("SIGTERM");
    process.exit(129); // 128 + SIGHUP(1)
  });
}

/**
 * Spawn a child in its own process group so its descendants can be reaped together.
 *
 * Drop-in for `child_process.spawn`, with `detached: true` forced on. The child
 * becomes its process-group leader. Cleanup is automatic on two triggers: when
 * the child exits, its group is swept (SIGTERM) so any grandchildren it left
 * running are not orphaned; and if the parent process exits first, every tracked
 * group is SIGTERM'd. Do not call `.unref()` on the returned child — the parent
 * should keep waiting on it.
 *
 * @param command - Executable to run.
 * @param args - Arguments passed to the executable.
 * @param options - Standard spawn options; `detached` is overridden to `true`.
 * @returns The spawned {@link ChildProcess}.
 */
export function spawnReapable(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  installExitHandlers();

  const child = spawn(command, args as string[], { ...options, detached: true });

  const pgid = child.pid;
  if (pgid !== undefined) {
    trackedGroups.add(pgid);
    child.on("exit", () => {
      trackedGroups.delete(pgid);
      // Sweep anything the child left running in its group — orphaned dev
      // servers, watchers, etc. The child itself has already exited, so the
      // only remaining group members are leftovers we want gone. This is what
      // keeps a long-lived host (e.g. the webhook server) from accumulating
      // orphans between restarts, since its own "exit" handler never fires.
      try {
        process.kill(-pgid, "SIGTERM");
      } catch {
        // Group already empty; nothing left to sweep.
      }
    });
  }

  return child;
}

/**
 * Signal an entire process group spawned via {@link spawnReapable}.
 *
 * Kills the child *and everything it spawned* by signalling the negative PID
 * (the process group). Falls back to signalling just the child if the group is
 * already gone. Use this instead of `child.kill()` for timeout/cleanup paths so
 * grandchildren (dev servers, watchers) are not left orphaned.
 *
 * @param child - A child returned by {@link spawnReapable}.
 * @param signal - Signal to send (default `SIGTERM`).
 */
export function reapTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pgid = child.pid;
  if (pgid === undefined) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already dead.
    }
  }
}
