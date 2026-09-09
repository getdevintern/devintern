/**
 * Idle self-update for the workspace worker daemon.
 *
 * The worker runs for weeks under systemd/launchd, while globally installed
 * CLIs only offer updates interactively. This module arms a periodic check
 * that installs a newer `@getdevintern/code` into the global install — but
 * only while the worker is idle:
 *
 * - A check is due at most once per calendar day (shared 24h cache in
 *   `~/.devintern/update-check.json`, the same cache interactive checks use),
 *   or sooner when the cache already holds a newer version that a previous
 *   busy window (or an interactive decline) left behind. After any attempt,
 *   the daily interval also applies again, so failures back off instead of
 *   retrying on every tick.
 * - "Idle" means the admission supervisor has zero running and zero queued
 *   jobs. When a check is due while busy, the worker waits for the next idle
 *   tick instead of interrupting work.
 * - Once idle, admissions are held (queued agent jobs are deferred and
 *   retried on the next poll; running jobs are never aborted) so no new work
 *   starts during the check and install. A skip releases the hold; a
 *   successful install keeps it and shuts the worker down.
 * - Restart: a service manager brings the worker back (the process exits
 *   non-zero, which both systemd `Restart=on-failure` and launchd
 *   `SuccessfulExit=false` treat as a restart); without one, the worker
 *   spawns its own successor on the new binary before exiting.
 * - Opt-out: `[worker] auto_update = false` in `workspace.toml` (live
 *   reload), `DEVINTERN_NO_UPDATE=1`, or `--no-update`. Source checkouts,
 *   `bun link`, and local `node_modules` installs are never updated.
 *
 * Every failure path is non-fatal: registry, network, or install errors log
 * and leave the current version running for the next idle window.
 */

import { spawn } from "node:child_process";
import {
  detectInstallKind,
  installGlobalCliAsync,
  isCliUpdateCheckDue,
  maybeOfferCliUpdate,
  shouldSkipUpdateCheck,
} from "@devintern/utils";
import type { TaskSupervisor } from "../task-supervisor";
import type { WorkspaceConfig } from "./config";

/** How often the armed timer re-evaluates the update conditions. */
export const WORKER_AUTO_UPDATE_TICK_MS = 60_000;

/** Minimum ms between "busy" notices while a due check waits for idle. */
const BUSY_LOG_INTERVAL_MS = 60 * 60 * 1000;

/** Default minimum ms between registry checks (matches the CLI update cache). */
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How long the successor handover waits for the child's spawn/error verdict
 * before assuming the spawn worked (spawn failures surface asynchronously).
 */
const SUCCESSOR_SPAWN_VERIFY_MS = 500;

const PACKAGE_NAME = "@getdevintern/code";
const BIN_NAME = "devintern";

export interface IdleAutoUpdaterOptions {
  /**
   * The live workspace config instance the whole worker shares;
   * `[worker].auto_update` is re-read on every tick so the opt-out applies
   * without a restart (see `applyWorkspaceConfig`).
   */
  config: WorkspaceConfig;
  /** Admission supervisor; the running + queued job counts are the idle signal. */
  supervisor: TaskSupervisor;
  /** Running CLI version. */
  cliVersion: string;
  /**
   * Begin the worker's graceful shutdown after a successful install. Called
   * at most once per attempt; implementations must be idempotent.
   */
  requestShutdown: () => void;
  /** argv used for opt-out detection and the successor spawn (tests). */
  argv?: string[];
  /** Env used for opt-out detection and manager detection (tests). */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock now (tests). */
  now?: () => number;
  /** Minimum ms between registry checks (default 24h). */
  checkIntervalMs?: number;
  /** Override the shared update-check cache file path (tests). */
  cachePath?: string;
  /** Injected fetch (tests). */
  fetchFn?: typeof fetch;
  /** Override the update attempt (tests). */
  runCheck?: () => Promise<"updated" | "skipped">;
  /** Override due-ness (tests). */
  isDue?: () => boolean;
  /** Override successor spawn (tests). */
  spawnSuccessor?: () => boolean | Promise<boolean>;
  /** Override service-manager detection (tests). */
  underServiceManager?: () => boolean;
  /**
   * Override the install command (tests); the updater still re-checks the
   * `[worker]` opt-out before delegating to it.
   */
  installFn?: (opts: {
    packageManager: "npm" | "bun";
    packageName: string;
    version: string;
  }) => boolean | Promise<boolean>;
  /** Injected logger (tests; defaults to console). */
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface IdleAutoUpdaterHandle {
  /** Arm the periodic tick. The timer never keeps the process alive. */
  start(): void;
  /** Disarm the timer. */
  stop(): void;
  /** Run one evaluation immediately (also used by tests). */
  tick(): Promise<void>;
  /** True once an update was installed and the process should hand over. */
  isRestartPending(): boolean;
  /**
   * Exit code for the shutdown handler after cleanup: non-zero asks a
   * service manager to restart the worker on the installed version;
   * otherwise the successor spawn covers it and the worker exits 0. The
   * spawn result is awaited (spawn failures surface asynchronously), so a
   * failed handover also asks the service manager path via the non-zero
   * status. Undefined when no restart is pending (regular exit code 0
   * applies).
   */
  finalExitCode(): Promise<number | undefined>;
}

/**
 * Env var tagging a worker that a previous worker spawned as its own
 * successor (see `spawnWorkerSuccessor`). Once the parent exits, macOS
 * reparents the detached child to launchd (pid 1), which is indistinguishable
 * from a launchd job by ppid alone — so a tagged worker must never take the
 * manager-restart path (exit non-zero expecting a relaunch that will never
 * come) and instead always spawns its own successor.
 */
export const WORKER_HANDOVER_ENV_VAR = "DEVINTERN_HANDOVER";

/**
 * Whether this process was started by a service manager, so exiting non-zero
 * makes it come back (systemd user unit or launchd agent). systemd exports
 * `INVOCATION_ID`/`SYSTEMD_EXEC_PID` to every unit process; generated
 * definitions set `DEVINTERN_SERVICE=1` (launchd exports no identifying
 * variables). As a fallback on macOS, a job parented directly by launchd
 * (pid 1) is also treated as manager-supervised — except for handover
 * successors (`DEVINTERN_HANDOVER=1`, set by `spawnWorkerSuccessor`): their
 * pid-1 parent may just be launchd reparenting an orphan, so the ppid
 * heuristic is skipped for them and they self-spawn instead. The explicit
 * markers above stay authoritative for tagged processes too.
 */
export function runningUnderServiceManager(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  ppid: number = process.ppid,
): boolean {
  if (env.DEVINTERN_SERVICE === "1") return true;
  if (env.INVOCATION_ID) return true;
  if (env.SYSTEMD_EXEC_PID) return true;
  if (env[WORKER_HANDOVER_ENV_VAR] === "1") return false;
  if (platform === "darwin" && ppid === 1) return true;
  return false;
}

/**
 * Whether `pid` belongs to a live process, probed with signal 0. A missing
 * pid (the spawn already failed) reads as dead; EPERM still means the
 * process exists (owned by another user), so only ESRCH reads as dead.
 */
function isProcessAlive(
  pid: number | undefined,
  signalFn: typeof process.kill = process.kill,
): boolean {
  if (!pid) return false;
  try {
    signalFn(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Spawn a replacement worker process on the (already updated) global
 * install, detached so it outlives this process and survives terminal
 * hangups. The successor is tagged `DEVINTERN_HANDOVER=1` so its own update
 * cycle cannot mistake macOS's reparent-to-launchd (pid 1) for service-
 * manager supervision and exit non-zero for a restart that will never come.
 * Resolves false when the spawn could not even be started — either
 * `spawn()` threw synchronously, the child reported an async spawn error
 * (e.g. EAGAIN/ENOENT), or the successor process is not actually running
 * when the spawn-verdict wait ends — so the caller can fall back to the
 * restart-requested exit code instead of exiting 0 with no daemon.
 */
export function spawnWorkerSuccessor(options?: {
  argv?: string[];
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  /** Override the spawn-verdict wait (tests). */
  verifyTimeoutMs?: number;
  /** Override the liveness probe used at the verdict wait (tests). */
  signalFn?: typeof process.kill;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): Promise<boolean> {
  const log = options?.log ?? console.log;
  const warn = options?.warn ?? console.warn;
  const execPath = options?.execPath ?? process.execPath;
  const args = (options?.argv ?? process.argv).slice(1);
  const spawnFn = options?.spawnFn ?? spawn;
  const signalFn = options?.signalFn ?? process.kill;
  const env = { ...(options?.env ?? process.env), [WORKER_HANDOVER_ENV_VAR]: "1" };
  try {
    const child = spawnFn(execPath, args, {
      detached: true,
      stdio: "inherit",
      env,
    });
    child.unref();
    log(`🔁 [update] handing over to the updated worker (pid ${child.pid ?? "?"})`);
    // spawn() rarely throws synchronously; failures surface later via the
    // 'error' event. Wait briefly for the spawn/error verdict before letting
    // the caller decide the exit code.
    // oxlint-disable-next-line promise/avoid-new -- deliberate event-to-promise bridge for the spawn verdict.
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (spawned: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(spawned);
      };
      child.once("spawn", () => settle(true));
      child.once("error", (error) => {
        warn(`⚠️  [update] replacement worker failed to start: ${(error as Error).message}`);
        settle(false);
      });
      // Neither event fired (custom spawnFn, slow runtime): only assume the
      // handover worked when the successor process is actually alive. An
      // async 'error' (e.g. EAGAIN under load) can arrive after this wait,
      // when the caller is already committed to its exit code — exiting 0
      // with no daemon running would leave the worker down until a manual
      // restart, so a non-running successor must read as a failed handover.
      const timeout = setTimeout(() => {
        if (settled) return;
        if (isProcessAlive(child.pid, signalFn)) {
          settle(true);
          return;
        }
        warn(
          `⚠️  [update] replacement worker (pid ${child.pid ?? "?"}) is not running; treating the handover as failed.`,
        );
        settle(false);
      }, options?.verifyTimeoutMs ?? SUCCESSOR_SPAWN_VERIFY_MS);
      timeout.unref?.();
    });
  } catch (error) {
    warn(`⚠️  [update] could not start the updated worker: ${(error as Error).message}`);
    return Promise.resolve(false);
  }
}

/**
 * Build the idle self-update loop. See the module doc for the policy; every
 * condition is evaluated per tick so live config edits apply immediately.
 */
export function createIdleWorkerAutoUpdater(
  options: IdleAutoUpdaterOptions,
): IdleAutoUpdaterHandle {
  const log = options.log ?? ((message: string) => console.log(message));
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const supervisor = options.supervisor;

  const installKind = detectInstallKind({
    scriptPath: argv[1] ?? "",
    packageName: PACKAGE_NAME,
  });
  const globalInstall = installKind === "npm-global" || installKind === "bun-global";

  let timer: ReturnType<typeof setInterval> | null = null;
  let attemptInFlight = false;
  let restartPending = false;
  let lastAttemptAt = 0;
  let lastBusyLogAt = -BUSY_LOG_INTERVAL_MS;
  // One-time skip notices: static conditions (env opt-out, non-global
  // install) must not repeat on every tick.
  const loggedOnce = new Set<string>();

  const logOnce = (key: string, message: string): void => {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    log(message);
  };

  const buildCheck = (): (() => Promise<"updated" | "skipped">) => {
    if (options.runCheck) return options.runCheck;
    return () =>
      maybeOfferCliUpdate({
        packageName: PACKAGE_NAME,
        binName: BIN_NAME,
        currentVersion: options.cliVersion,
        isInteractive: false,
        autoInstall: true,
        noUpdateEnv: "DEVINTERN_NO_UPDATE",
        argv,
        env,
        installKind,
        checkIntervalMs,
        cachePath: options.cachePath,
        fetchFn: options.fetchFn,
        now,
        log,
        installFn: async (install) => {
          // The opt-out can flip while the registry check runs; the install
          // is the first irreversible step, so re-check right before it.
          if (!options.config.worker.autoUpdate) {
            log(
              "[update] [worker] auto_update was disabled while the check ran; skipping install.",
            );
            return false;
          }
          return (options.installFn ?? installGlobalCliAsync)(install);
        },
        reexecFn: () => {
          // The default re-exec would run the daemon as a synchronous child;
          // instead mark the handover and let the caller shut down gracefully.
          restartPending = true;
        },
      });
  };

  const isDue = (): boolean => {
    if (options.isDue) return options.isDue();
    // After any attempt (skip, failure, or install), the daily interval
    // applies again so a persistent failure cannot retry on every tick.
    const at = now();
    if (lastAttemptAt !== 0 && at - lastAttemptAt < checkIntervalMs) return false;
    return isCliUpdateCheckDue({
      packageName: PACKAGE_NAME,
      currentVersion: options.cliVersion,
      cachePath: options.cachePath,
      checkIntervalMs,
      now,
    });
  };

  // Idle means nothing running and nothing queued: a custom supervisor may
  // keep admitted-but-unstarted jobs in its own queue, and starting an
  // update on top of those would strand or reject them.
  const activeJobCount = (): number =>
    supervisor.inFlightCount() + (supervisor.queuedCount?.() ?? 0);

  const tick = async (): Promise<void> => {
    if (attemptInFlight || restartPending) return;

    if (shouldSkipUpdateCheck({ argv, env, noUpdateEnv: "DEVINTERN_NO_UPDATE" })) {
      logOnce(
        "env-opt-out",
        "[update] CLI self-update disabled by DEVINTERN_NO_UPDATE/--no-update; skipping.",
      );
      return;
    }
    if (!options.config.worker.autoUpdate) {
      logOnce(
        "config-opt-out",
        "[update] CLI self-update disabled by [worker] auto_update = false; skipping.",
      );
      return;
    }
    // A later disable should be visible again (the opt-out live-reloads).
    loggedOnce.delete("config-opt-out");
    if (!options.cliVersion || options.cliVersion === "0.0.0") {
      // Dev/unknown version — never treated as stale (same policy as the CLI).
      return;
    }
    if (!globalInstall) {
      logOnce(
        "non-global",
        `[update] ${BIN_NAME} is not a global npm/bun install (${installKind}); self-update skipped.`,
      );
      return;
    }
    if (!isDue()) return;

    if (activeJobCount() > 0) {
      // Busy: wait for idle instead of interrupting work. Re-evaluated on the
      // next tick; a job running longer than a day just defers the update.
      const at = now();
      if (at - lastBusyLogAt >= BUSY_LOG_INTERVAL_MS) {
        lastBusyLogAt = at;
        log("[update] update check is due but agent work is in progress; waiting for idle.");
      }
      return;
    }

    // Idle and due: hold admissions so no new work starts during the check
    // and install, run the attempt, then release (skip) or hand over (update).
    supervisor.holdAdmissions();
    if (activeJobCount() > 0) {
      // A job raced past the idle check (possible with a custom supervisor);
      // release and retry on the next tick rather than running over it.
      supervisor.resume();
      return;
    }

    attemptInFlight = true;
    let outcome: "updated" | "skipped" = "skipped";
    try {
      log(`[update] checking npm for ${PACKAGE_NAME} updates (current: ${options.cliVersion})`);
      outcome = await buildCheck()();
    } catch (error) {
      warn(`⚠️  [update] self-update check failed: ${(error as Error).message}`);
      outcome = "skipped";
    } finally {
      attemptInFlight = false;
      lastAttemptAt = now();
    }

    if (outcome === "updated") {
      restartPending = true;
      options.requestShutdown();
      return;
    }
    supervisor.resume();
    log(`[update] check complete; continuing on ${BIN_NAME} ${options.cliVersion}`);
  };

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => void tick(), WORKER_AUTO_UPDATE_TICK_MS);
      timer.unref?.();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    tick,
    isRestartPending(): boolean {
      return restartPending;
    },
    async finalExitCode(): Promise<number | undefined> {
      if (!restartPending) return undefined;
      if (options.underServiceManager?.() ?? runningUnderServiceManager(env)) {
        log(
          "[update] exiting with a restart-requested status so the service manager " +
            "brings the worker back on the new version.",
        );
        return 1;
      }
      const spawned = await (options.spawnSuccessor ?? spawnWorkerSuccessor)({ log, warn });
      return spawned ? 0 : 1;
    },
  };
}
