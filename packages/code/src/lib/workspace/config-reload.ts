/**
 * Live configuration reload for the fleet worker.
 *
 * The worker is an unattended daemon: tuning `workspace.toml` (routing
 * rules, repos, automations, cadence) must not require restarting it, or
 * tracker events and relay messages get missed during the bounce.
 *
 * Design: every consumer holds a reference to one shared `WorkspaceConfig`
 * instance for the lifetime of the process. {@link applyWorkspaceConfig}
 * swaps that instance's top-level fields in place on each successful reload,
 * so routing decisions, repo lookups, per-repo environments, and relay
 * handling read the current config without any rewiring. Consumers that
 * snapshot values at construction (the automation scheduler, polling
 * intervals) reconcile through the {@link WorkspaceConfigReloaderOptions.onApplied}
 * callback.
 *
 * Failure policy: a malformed or semantically invalid file is logged and
 * ignored — the worker keeps serving with the last valid configuration and
 * never crashes on a bad edit.
 */

import { createHash } from "crypto";
import { readFileSync, renameSync, statSync, watch, writeFileSync } from "fs";
import { basename, dirname } from "path";

import type { WorkspaceConfig } from "./config";
import { loadWorkspaceConfig } from "./config";
import { workspaceAppliedConfigPath } from "./paths";

/** Coalescing window for rapid successive edits before reloads run. */
export const DEFAULT_RELOAD_DEBOUNCE_MS = 300;

/**
 * Swap {@linkcode target}'s top-level sections in place so every holder of
 * the original object observes the updated configuration. Fields are
 * assigned synchronously (no awaits), so no reader sees a half-applied set.
 *
 * The `worker` section is swapped too, so `[worker]` settings such as
 * `auto_update` apply live; startup-only keys it contains (today
 * `[worker.schedule]`) are startup-only because the daemon installs
 * {@linkcode import("./workspace-worker").validateReloadedWorkspaceConfig}
 * as the reloader's `validate` hook, which rejects them before this
 * function runs.
 */
export function applyWorkspaceConfig(target: WorkspaceConfig, next: WorkspaceConfig): void {
  target.workspace = next.workspace;
  target.worker = next.worker;
  target.defaults = next.defaults;
  target.teams = next.teams;
  target.repos = next.repos;
  target.routing = next.routing;
  target.automations = next.automations;
  target.estimations = next.estimations;
}

/** Deterministic serialization used to skip no-op saves/touches. */
export function serializeWorkspaceConfig(config: WorkspaceConfig): string {
  return JSON.stringify(config);
}

export interface ReloadOutcome {
  /** True when a new configuration was parsed, validated, and applied. */
  applied: boolean;
  /** True when disk content parsed but matched the already-active config. */
  unchanged?: boolean;
  /** Why the on-disk file was rejected (parse, validation, or startup-only change). */
  error?: string;
}

export interface WorkspaceConfigReloaderOptions {
  /** Absolute path of the watched `workspace.toml`. */
  configPath: string;
  /**
   * The live config instance the worker consumers share; mutated in place
   * by each applied reload (see {@link applyWorkspaceConfig}).
   */
  current: WorkspaceConfig;
  /** Parse/validate step (injected for tests). Defaults to loadWorkspaceConfig. */
  load?: (path: string) => WorkspaceConfig;
  /** Coalescing window in milliseconds for rapid successive edits. */
  debounceMs?: number;
  /** Called after a changed config was applied (reconcile acquirers here). */
  onApplied?: (config: WorkspaceConfig) => void;
  /** Final runtime validation before the shared config is mutated. */
  validate?: (next: WorkspaceConfig, current: WorkspaceConfig) => void;
  /** Error sink (injected for tests). Defaults to console.error. */
  onError?: (message: string) => void;
  /** Called after every reload attempt (applied, unchanged, or rejected). */
  onOutcome?: (outcome: ReloadOutcome) => void;
}

/**
 * Watches `workspace.toml` and applies validated edits to the running
 * worker.
 *
 * - File watching follows the config's directory (editors replace files via
 *   rename, which does not fire on the inode being watched).
 * - Rapid successive edits are coalesced (trailing-edge debounce).
 * - Invalid edits are surfaced through the error sink and dropped; the last
 *   valid configuration keeps serving.
 * - `SIGHUP` triggers a manual reload as a fallback when file watching is
 *   unavailable (e.g. inotify limits).
 */
export class WorkspaceConfigReloader {
  private readonly options: Required<Pick<WorkspaceConfigReloaderOptions, "debounceMs">> &
    WorkspaceConfigReloaderOptions;
  private watcher: ReturnType<typeof watch> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private signalHandler: (() => void) | null = null;
  private stopped = false;

  constructor(options: WorkspaceConfigReloaderOptions) {
    this.options = { ...options, debounceMs: options.debounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS };
  }

  /** Start watching the config directory and install the SIGHUP fallback. */
  start(): void {
    if (this.stopped) return;
    this.installSignalFallback();
    try {
      this.watcher = watch(dirname(this.options.configPath), (_event, filename) => {
        if (!filename || filename === basename(this.options.configPath)) {
          this.scheduleReload("file change");
        }
      });
      this.watcher.on("error", (error) => {
        this.reportError(
          `workspace.toml watcher failed (${(error as Error).message}); ` +
            "send SIGHUP to force a config reload.",
        );
        this.closeWatcher();
      });
      // Catch up on an edit that lands while the watcher is attaching (an
      // edit racing the initial registration would otherwise be missed);
      // identical content is filtered out by the no-op check.
      this.scheduleReload("watcher attached");
    } catch (error) {
      this.reportError(
        `Could not watch ${this.options.configPath} for changes ` +
          `(${(error as Error).message}); send SIGHUP to reload after editing.`,
      );
    }
  }

  /** Stop watching and clear pending reloads. */
  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.closeWatcher();
  }

  /**
   * Read, validate, and apply the on-disk configuration.
   *
   * @param reason - Human-readable trigger for log messages ("SIGHUP",
   *                 "file change", …).
   * @returns Whether a new config was applied, and whether it was a no-op.
   */
  reload(reason: string): ReloadOutcome {
    const outcome = this.reloadOnce(reason);
    this.options.onOutcome?.(outcome);
    return outcome;
  }

  private reloadOnce(reason: string): ReloadOutcome {
    let next: WorkspaceConfig;
    try {
      next = (this.options.load ?? loadWorkspaceConfig)(this.options.configPath);
    } catch (error) {
      const message = (error as Error).message;
      this.reportError(
        `Failed to reload workspace config (${reason}): ${message}\n` +
          "   Continuing with the previously loaded configuration.",
      );
      return { applied: false, error: message };
    }

    if (serializeWorkspaceConfig(next) === serializeWorkspaceConfig(this.options.current)) {
      return { applied: false, unchanged: true };
    }

    try {
      this.options.validate?.(next, this.options.current);
    } catch (error) {
      const message = (error as Error).message;
      this.reportError(
        `Failed to reload workspace config (${reason}): ${message}\n` +
          "   Continuing with the previously loaded configuration.",
      );
      return { applied: false, error: message };
    }

    applyWorkspaceConfig(this.options.current, next);
    console.log(
      `🔄 [config] Reloaded ${this.options.configPath} ` +
        `(${next.teams.length} team(s), ${next.repos.length} repo(s), ` +
        `${next.routing.length} routing rule(s), ` +
        `${next.automations.length} automation(s), ${next.estimations.length} estimation(s))`,
    );
    this.options.onApplied?.(this.options.current);
    return { applied: true };
  }

  /** Queue a debounced reload (coalesces rapid successive edits). */
  scheduleReload(reason: string): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reload(reason);
    }, this.options.debounceMs);
  }

  /**
   * Manual reload fallback for environments where file watching is
   * unavailable. Installed once per reloader (the daemon creates a single
   * reloader; the handler outlives stop(), which only tears down the watcher).
   *
   * A pre-existing SIGHUP listener is not a reason to skip installation:
   * `@devintern/agent-harness`'s process reaper registers one for cleanup and
   * terminates on SIGHUP only when it is the sole owner, so the two coexist —
   * the reloader claims SIGHUP for a live reload while the reaper stands down.
   */
  private installSignalFallback(): void {
    if (this.signalHandler) return;
    this.signalHandler = () => this.reload("SIGHUP");
    process.on("SIGHUP" as const, this.signalHandler as (signal: NodeJS.Signals) => void);
  }

  private closeWatcher(): void {
    if (!this.watcher) return;
    try {
      this.watcher.close();
    } catch {
      // Already closed.
    }
    this.watcher = null;
  }

  private reportError(message: string): void {
    const onError = this.options.onError ?? ((text: string) => console.error(text));
    onError(message);
  }
}

/** Identity of one on-disk version of `workspace.toml`. */
export interface ConfigFileFingerprint {
  /** File mtime (epoch ms, rounded). */
  fileModifiedAt: number;
  /** sha256 of the file bytes. */
  contentHash: string;
}

/**
 * Which `workspace.toml` version the running worker last applied, and the
 * last version it rejected. Written by the worker at startup and after every
 * reload attempt; the dashboard compares it with the file on disk to tell
 * whether a saved edit is live.
 */
export interface AppliedConfigRecord extends ConfigFileFingerprint {
  /** Worker process that wrote the record (a record from another pid is stale). */
  pid: number;
  /** When this version was applied (epoch ms). */
  appliedAt: number;
  /** Last rejected version; cleared when a later version applies. */
  rejection?: ConfigFileFingerprint & { at: number; reason: string };
}

/** Fingerprint the config file, or null when it cannot be read. */
export function fingerprintConfigFile(configPath: string): ConfigFileFingerprint | null {
  try {
    const bytes = readFileSync(configPath);
    return {
      fileModifiedAt: Math.round(statSync(configPath).mtimeMs),
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return null;
  }
}

/** Read the applied-config record, or null when absent or malformed. */
export function readAppliedConfigRecord(workspaceDir: string): AppliedConfigRecord | null {
  try {
    const raw = JSON.parse(
      readFileSync(workspaceAppliedConfigPath(workspaceDir), "utf8"),
    ) as Partial<AppliedConfigRecord>;
    if (
      typeof raw.pid !== "number" ||
      typeof raw.appliedAt !== "number" ||
      typeof raw.fileModifiedAt !== "number" ||
      typeof raw.contentHash !== "string"
    ) {
      return null;
    }
    const rejection = raw.rejection;
    const validRejection =
      rejection &&
      typeof rejection.at === "number" &&
      typeof rejection.reason === "string" &&
      typeof rejection.fileModifiedAt === "number" &&
      typeof rejection.contentHash === "string";
    return {
      pid: raw.pid,
      appliedAt: raw.appliedAt,
      fileModifiedAt: raw.fileModifiedAt,
      contentHash: raw.contentHash,
      rejection: validRejection ? rejection : undefined,
    };
  } catch {
    return null;
  }
}

function writeAppliedConfigRecord(workspaceDir: string, record: AppliedConfigRecord): void {
  const path = workspaceAppliedConfigPath(workspaceDir);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    // Observability only: never fail a reload over the dashboard record.
    console.warn(`⚠️  Could not record the applied workspace config: ${(error as Error).message}`);
  }
}

/**
 * Record that the file currently on disk is the version the worker runs
 * (startup load, applied reload, or a semantically identical save).
 */
export function recordConfigApplied(
  workspaceDir: string,
  configPath: string,
  now: number = Date.now(),
  pid: number = process.pid,
): void {
  const fingerprint = fingerprintConfigFile(configPath);
  if (!fingerprint) return;
  writeAppliedConfigRecord(workspaceDir, { pid, appliedAt: now, ...fingerprint });
}

/** Record that the file currently on disk was rejected, keeping the applied version. */
export function recordConfigRejected(
  workspaceDir: string,
  configPath: string,
  reason: string,
  now: number = Date.now(),
  pid: number = process.pid,
): void {
  const previous = readAppliedConfigRecord(workspaceDir);
  const fingerprint = fingerprintConfigFile(configPath);
  if (!previous || previous.pid !== pid || !fingerprint) return;
  writeAppliedConfigRecord(workspaceDir, {
    ...previous,
    rejection: { ...fingerprint, at: now, reason },
  });
}

/** Reloader `onOutcome` hook that keeps the applied-config record current. */
export function appliedConfigRecorder(
  workspaceDir: string,
  configPath: string,
): (outcome: ReloadOutcome) => void {
  return (outcome) => {
    if (outcome.error !== undefined) {
      recordConfigRejected(workspaceDir, configPath, outcome.error);
    } else {
      recordConfigApplied(workspaceDir, configPath);
    }
  };
}
