/**
 * Harness failover state machine for worker mode.
 *
 * Given a priority-ordered harness chain (from `AGENT_HARNESS=claude-code,codex`),
 * tracks the active harness and per-harness usage-limit windows so the queue
 * keeps processing on a fallback when the primary hits its limit, and returns
 * to the primary once its window elapses (failback).
 *
 * This module is the in-memory source of truth. Persistence hooks let the
 * webhook server mirror the state into the queue database (`webhook_meta`
 * keys, per-harness) so a worker restart recovers the windows and the active
 * harness instead of immediately retrying a still-limited agent.
 *
 * Selection is deterministic: the active harness is always the highest-priority
 * (lowest-index) entry whose limit window has elapsed, so failback to the
 * primary happens automatically as soon as its window ends.
 */

import type { HarnessChainEntry } from "@devintern/agent-harness";

/** What happened after a harness reported a usage limit. */
export type FailoverOutcome =
  | {
      kind: "switched";
      from: string;
      to: string;
      /** Epoch ms when the from-harness window ends. */
      untilMs: number;
    }
  | {
      kind: "stayed";
      entry: string;
      untilMs: number;
    }
  | {
      kind: "exhausted";
      /** Every chain entry is limited; the caller must pause the queue. */
      untilMs: number;
    };

/** Persistence + clock hooks injected by the host (webhook server / tests). */
export interface HarnessFailoverOptions {
  /** Priority-ordered usable chain entries (from `resolveHarnessChain`). */
  entries: HarnessChainEntry[];
  /** Injectable clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Persist a per-harness limit window (epoch ms). */
  persistLimit?: (harness: string, untilMs: number) => void;
  /** Remove a harness's persisted limit window. */
  clearPersistedLimit?: (harness: string) => void;
  /** Persist the current active harness name. */
  persistActive?: (harness: string) => void;
  /** Log line override (tests). Defaults to `console.log`. */
  log?: (message: string) => void;
}

/**
 * Manage the active harness of a chain and its per-harness limit windows.
 */
export class HarnessFailover {
  private readonly entries: HarnessChainEntry[];
  private readonly limited = new Map<string, number>();
  private activeIndex = 0;
  private readonly now: () => number;
  private readonly persistLimit?: (harness: string, untilMs: number) => void;
  private readonly clearPersistedLimit?: (harness: string) => void;
  private readonly persistActive?: (harness: string) => void;
  private readonly log: (message: string) => void;

  constructor(options: HarnessFailoverOptions) {
    if (options.entries.length === 0) {
      throw new Error("HarnessFailover requires at least one chain entry");
    }
    this.entries = options.entries;
    this.now = options.now ?? Date.now;
    this.persistLimit = options.persistLimit;
    this.clearPersistedLimit = options.clearPersistedLimit;
    this.persistActive = options.persistActive;
    this.log = options.log ?? ((message: string) => console.log(message));
  }

  /** The currently active chain entry. */
  get active(): HarnessChainEntry {
    return this.entries[this.activeIndex]!;
  }

  /** Canonical name of the active harness. */
  get activeName(): string {
    return this.active.name;
  }

  /** Whether the active harness is the first (priority) entry. */
  get onPrimary(): boolean {
    return this.activeIndex === 0;
  }

  /** Ordered canonical names, for logging ("a → b → c"). */
  describeChain(): string {
    return this.entries.map((e) => e.name).join(" → ");
  }

  /**
   * Snapshot of the tracked per-harness limit windows (epoch ms).
   *
   * Entries whose window has already ended are left in place until
   * {@link windowElapsed} clears them, so a host timer can observe the
   * expiration and run the failback.
   */
  windows(): Record<string, number> {
    return Object.fromEntries(this.limited);
  }

  /**
   * Seed state from persisted per-harness windows (queue DB) after a restart.
   *
   * Future windows for harnesses still in the chain are restored; expired
   * windows and windows for harnesses no longer in the chain (list reordered
   * or shortened) are dropped from persistence as stale state. Selection
   * afterwards is priority-driven: the highest-priority entry without an
   * open window becomes active, so a still-limited primary is never retried
   * and a fallback from before the restart is kept when it is the best
   * available entry. The persisted active name is only used to warn when it
   * has left the chain.
   *
   * @param windows - Persisted harness → limit-until (epoch ms) map
   * @param activeName - Persisted active harness name, when known
   * @returns Warning lines for stale state the caller should log.
   */
  restore(windows: Record<string, number>, activeName?: string | null): string[] {
    const warnings: string[] = [];
    const nowMs = this.now();

    for (const [harness, untilMs] of Object.entries(windows)) {
      if (!this.entries.some((e) => e.name === harness)) {
        warnings.push(
          `Failover state references harness "${harness}", which is not in the current AGENT_HARNESS chain; ignoring its limit window.`,
        );
        this.clearPersistedLimit?.(harness);
        continue;
      }
      if (untilMs > nowMs) {
        this.limited.set(harness, untilMs);
      } else {
        // Stale window (already elapsed while the worker was down) — clear it.
        this.clearPersistedLimit?.(harness);
      }
    }

    if (activeName && !this.entries.some((e) => e.name === activeName)) {
      warnings.push(
        `Persisted active harness "${activeName}" is not in the current AGENT_HARNESS chain; falling back to the highest-priority available entry.`,
      );
    }

    const target = this.selectAvailable();
    if (target) {
      this.activeIndex = this.entries.indexOf(target);
    } else {
      // Everything limited: park on the primary; the queue starts paused and
      // the resume path reselects when the earliest window elapses.
      this.activeIndex = 0;
    }
    return warnings;
  }

  /** Whether the named harness currently has an open limit window. */
  isLimited(harness: string): boolean {
    const until = this.limited.get(harness);
    return until !== undefined && until > this.now();
  }

  /**
   * Record a usage limit for the active harness and fail over when possible.
   *
   * Extends an existing window (keeps the furthest reset), then switches to
   * the highest-priority entry that is not limited. When every entry is
   * limited the outcome is `exhausted` and the caller must pause its queue
   * until {@link earliestResetMs}.
   *
   * @param resetUntilMs - Epoch ms when the active harness's window ends
   *   (already resolved from the reset hint or a fallback cooldown).
   * @returns What the failover decided.
   */
  reportUsageLimit(resetUntilMs: number): FailoverOutcome {
    const from = this.active;
    this.setWindow(from.name, resetUntilMs);

    const target = this.selectAvailable();
    if (!target) {
      const untilMs = this.earliestResetMs() ?? resetUntilMs;
      this.log(
        `⛔ All harnesses in the chain are usage-limited (${this.describeChain()}); ` +
          `resuming when the earliest window ends at ${new Date(untilMs).toISOString()}.`,
      );
      return { kind: "exhausted", untilMs };
    }

    const toIndex = this.entries.indexOf(target);
    this.activeIndex = toIndex;
    this.persistActive?.(this.activeName);

    if (target.name !== from.name) {
      const fallbackPosition =
        toIndex === 0 ? "primary" : `fallback ${toIndex + 1}/${this.entries.length}`;
      this.log(
        `🔁 ${from.name} hit a usage limit (until ${new Date(resetUntilMs).toISOString()}) — ` +
          `failing over to ${target.name} (${fallbackPosition} in the AGENT_HARNESS chain).`,
      );
      return { kind: "switched", from: from.name, to: target.name, untilMs: resetUntilMs };
    }

    return { kind: "stayed", entry: target.name, untilMs: resetUntilMs };
  }

  /**
   * Clear an elapsed limit window and fail back when that unlocks a
   * higher-priority harness.
   *
   * Called by the host timer when a persisted window ends. If the primary
   * (priority) harness becomes available again while a fallback is active,
   * the active harness returns to it — that is the failback.
   *
   * @param harness - Harness whose window elapsed.
   * @returns The harness now active, if a switch happened; otherwise null.
   */
  windowElapsed(harness: string): string | null {
    const hadWindow = this.limited.delete(harness);
    if (hadWindow) {
      this.clearPersistedLimit?.(harness);
    }

    const target = this.selectAvailable();
    if (!target || target.name === this.activeName) {
      return null;
    }

    const previous = this.active;
    this.activeIndex = this.entries.indexOf(target);
    this.persistActive?.(this.activeName);
    this.log(
      target.name === this.entries[0]!.name
        ? `⏪ ${harness} usage-limit window elapsed — failing back to primary harness ${target.name} (from ${previous.name}).`
        : `🔁 ${harness} usage-limit window elapsed — resuming on ${target.name} (from ${previous.name}).`,
    );
    return target.name;
  }

  /**
   * Epoch ms when the earliest open window ends (null when none open).
   *
   * Always in the future when non-null; expired-but-uncleaned windows are
   * ignored. The host arms its resume/failback timer at this instant.
   */
  earliestResetMs(): number | null {
    const nowMs = this.now();
    const open = [...this.limited.values()].filter((until) => until > nowMs);
    return open.length > 0 ? Math.min(...open) : null;
  }

  /** Whether every chain entry currently has an open limit window. */
  allLimited(): boolean {
    return this.entries.every((e) => this.isLimited(e.name));
  }

  /** Highest-priority entry without an open window, or null when all limited. */
  private selectAvailable(): HarnessChainEntry | null {
    return this.entries.find((e) => !this.isLimited(e.name)) ?? null;
  }

  /** Store a window, keeping the furthest reset when one is already open. */
  private setWindow(harness: string, untilMs: number): void {
    const existing = this.limited.get(harness) ?? 0;
    const until = Math.max(existing, untilMs);
    this.limited.set(harness, until);
    this.persistLimit?.(harness, until);
  }
}
