/**
 * Worker startup outcome: exit codes for permanent startup failures and the
 * guard that records why a worker exited before it started.
 *
 * A worker under systemd or launchd that cannot start because of its own
 * configuration (no license, nobody signed in, an invalid workspace.toml)
 * used to exit 1 and be restarted every 30 seconds forever, with the reason
 * only in the journal. Permanent failures now exit {@link WORKER_CONFIG_EXIT_CODE},
 * which the generated systemd unit lists in `RestartPreventExitStatus=`, and
 * every startup failure is written to the lifecycle record that
 * `worker status` and `worker service` read.
 */

import { writeWorkerLifecycle } from "./lifecycle";

/** `EX_CONFIG` from sysexits.h: a configuration error a restart cannot fix. */
export const WORKER_CONFIG_EXIT_CODE = 78;

/** How many trailing error lines a startup-failure record keeps. */
const MESSAGE_LINES = 8;

type Env = Record<string, string | undefined>;

/**
 * Exit code for a permanent startup failure.
 *
 * launchd has no `RestartPreventExitStatus`: with `KeepAlive.SuccessfulExit =
 * false` it restarts every non-zero exit. Under the generated launchd agent
 * (which sets `DEVINTERN_SERVICE_MANAGER=launchd`) the worker therefore exits
 * 0 so launchd stops retrying; the lifecycle record still says it failed.
 */
export function permanentStartupExitCode(env: Env = process.env): number {
  return env.DEVINTERN_SERVICE_MANAGER === "launchd" ? 0 : WORKER_CONFIG_EXIT_CODE;
}

/**
 * Whether a failed license check needs the user (sign in, add or fix a
 * license) rather than another attempt. Failures to reach the license server
 * stay retryable, so a worker that boots before the network keeps trying.
 */
export function isPermanentLicenseDenial(result: {
  valid: boolean;
  message: string;
  signInRequired?: boolean;
  retryable?: boolean;
}): boolean {
  if (result.valid) return false;
  // The structured flag wins: the message may quote a server reason.
  if (result.retryable) return false;
  if (result.signInRequired) return true;
  return /invalid or revoked|does not match this product|requires an automation license|has no matching license|not signed in|Pilot (has )?(ended|expired)|already used/i.test(
    result.message,
  );
}

interface ArmedGuard {
  workspaceDir: string;
  recorded: boolean;
  signalled: boolean;
  errors: string[];
}

let armed: ArmedGuard | null = null;

function lastErrors(guard: ArmedGuard): string | undefined {
  const text = guard.errors.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Start recording why this worker process might exit before it starts.
 *
 * Keeps the last error lines the process prints and, if the process exits
 * before {@link markWorkerStarted}, writes a `startup_failed` record (or
 * `stopped`, when a signal ended the startup). Call once per daemon process.
 */
export function armWorkerStartupGuard(workspaceDir: string): void {
  if (armed) return;
  const guard: ArmedGuard = { workspaceDir, recorded: false, signalled: false, errors: [] };
  armed = guard;
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    if (armed === guard) {
      for (const line of args.map(String).join(" ").split("\n")) {
        if (line.trim()) guard.errors.push(line.trimEnd());
      }
      guard.errors.splice(0, Math.max(0, guard.errors.length - MESSAGE_LINES));
    }
    original(...args);
  };
  const onSignal = () => {
    guard.signalled = true;
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  process.once("exit", (code) => {
    if (armed !== guard || guard.recorded) return;
    guard.recorded = true;
    writeWorkerLifecycle(guard.workspaceDir, {
      state: guard.signalled ? "stopped" : "startup_failed",
      exitCode: code,
      ...(guard.signalled ? {} : { message: lastErrors(guard) }),
      ...(code === WORKER_CONFIG_EXIT_CODE ? { permanent: true } : {}),
    });
  });
}

/** Record a permanent startup failure and exit so the service manager stops retrying. */
export function exitWorkerStartupPermanently(hint?: string): never {
  if (hint) console.error(hint);
  const code = permanentStartupExitCode();
  if (armed && !armed.recorded) {
    armed.recorded = true;
    writeWorkerLifecycle(armed.workspaceDir, {
      state: "startup_failed",
      exitCode: code,
      message: lastErrors(armed),
      permanent: true,
    });
  }
  process.exit(code);
}

/**
 * Record that every event source started and disarm the startup guard.
 *
 * @param workspaceDir - Workspace home holding the lifecycle record
 */
export function markWorkerStarted(workspaceDir: string): void {
  armed = null;
  writeWorkerLifecycle(workspaceDir, { state: "started" });
}

/** Forget the armed guard. Tests only. */
export function resetWorkerStartupGuardForTests(): void {
  armed = null;
}
