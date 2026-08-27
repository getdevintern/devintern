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

import { watch } from "fs";
import { basename, dirname } from "path";

import type { WorkspaceConfig } from "./config";
import { loadWorkspaceConfig } from "./config";

/** Coalescing window for rapid successive edits before reloads run. */
export const DEFAULT_RELOAD_DEBOUNCE_MS = 300;

/**
 * Swap {@linkcode target}'s top-level sections in place so every holder of
 * the original object observes the updated configuration. Fields are
 * assigned synchronously (no awaits), so no reader sees a half-applied set.
 */
export function applyWorkspaceConfig(target: WorkspaceConfig, next: WorkspaceConfig): void {
  target.workspace = next.workspace;
  target.defaults = next.defaults;
  target.repos = next.repos;
  target.routing = next.routing;
  target.automations = next.automations;
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
  /** Error sink (injected for tests). Defaults to console.error. */
  onError?: (message: string) => void;
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
    let next: WorkspaceConfig;
    try {
      next = (this.options.load ?? loadWorkspaceConfig)(this.options.configPath);
    } catch (error) {
      this.reportError(
        `Failed to reload workspace config (${reason}): ` +
          `${(error as Error).message}\n` +
          "   Continuing with the previously loaded configuration.",
      );
      return { applied: false };
    }

    if (serializeWorkspaceConfig(next) === serializeWorkspaceConfig(this.options.current)) {
      return { applied: false, unchanged: true };
    }

    applyWorkspaceConfig(this.options.current, next);
    console.log(
      `🔄 [config] Reloaded ${this.options.configPath} ` +
        `(${next.repos.length} repo(s), ${next.routing.length} routing rule(s), ` +
        `${next.automations.length} automation(s))`,
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
   * unavailable. Installed once per process (the daemon creates a single
   * reloader; the handler outlives stop(), which only tears down the watcher).
   */
  private installSignalFallback(): void {
    if (process.listenerCount("SIGHUP") > 0 || this.signalHandler) return;
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
