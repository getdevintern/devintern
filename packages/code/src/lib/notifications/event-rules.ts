/**
 * Notification rules for events outside a run's finish: PRs DevIntern
 * opened or saw close, and automation source health.
 *
 * | Kind               | Trigger                                                  | Auto-resolve       |
 * | ------------------ | -------------------------------------------------------- | ------------------ |
 * | `pr_opened`        | the agent PR registry records a new (or reopened) PR; grouped per repo per day | (informational) |
 * | `source_unhealthy` | a source read turns bad: auth failed, or {@link UNREADABLE_THRESHOLD} unreadable reads in a row | the next `ok` read |
 *
 * A closed or merged PR resolves the `escalated` notifications about it.
 * Every entry point is best-effort and never throws.
 */

import type { Database } from "bun:sqlite";

import { redactText } from "@devintern/utils";
import { NotificationEmitter, safely } from "./emitter";
import { localDay, prSubject } from "./run-rules";

/** Consecutive `unreadable` reads before a source counts as unhealthy (one blip is not news). */
export const UNREADABLE_THRESHOLD = 3;

export interface OpenedPr {
  /** `owner/repo` or project path. */
  repo: string;
  number: number;
  url: string;
  taskKey?: string;
  /** Run that opened it (`DEVINTERN_RUN_ID` of the creating process). */
  runId?: number;
}

/**
 * Record a PR DevIntern opened, grouped with the repo's other PRs that day.
 *
 * @param db - Writable workspace DB connection
 * @param pr - The new PR
 */
export function notifyPrOpened(db: Database, pr: OpenedPr, now: () => number = Date.now): void {
  safely("pr-opened", () => {
    const label = `${pr.repo}#${pr.number}`;
    new NotificationEmitter(db, now).emit({
      kind: "pr_opened",
      severity: "normal",
      groupKey: `pr_opened:${pr.repo}:${localDay(now())}`,
      runId: pr.runId,
      repo: pr.repo,
      title: `Opened ${label}`,
      groupTitle: (count) =>
        count === 1 ? `Opened ${label}` : `Opened ${count} PRs in ${pr.repo} today`,
      body: pr.taskKey ? `${label} for ${pr.taskKey}` : undefined,
      links: [
        {
          label: pr.taskKey ? `${label} (${pr.taskKey})` : label,
          url: pr.url,
          ...(pr.runId !== undefined ? { runId: pr.runId } : {}),
        },
      ],
      appendLinks: true,
      // The registry only calls this for a new or reopened PR, so each emit is
      // a real PR even when one run opens several.
      distinctEvents: true,
    });
  });
}

/**
 * A PR closed or merged: resolve the escalations about it (an auto-merge
 * escalation names the PR as its subject; a task run's escalation recorded
 * the PR on its run).
 *
 * @param db - Writable workspace DB connection
 * @param prUrl - Web URL of the closed PR
 */
export function notifyPrClosed(db: Database, prUrl: string, now: () => number = Date.now): void {
  safely("pr-closed", () => {
    new NotificationEmitter(db, now).resolve({
      kinds: ["escalated"],
      subject: prSubject(prUrl),
      runPrUrl: prUrl,
    });
  });
}

/** One source read, with the stored state from before it. */
export interface SourceHealthChange {
  provider: string;
  sourceId: string;
  status: string;
  /** Generic failure count shown on the sources dashboard. */
  consecutiveFailures: number;
  /** `unreadable` reads in a row (rate limits do not count); drives the threshold. */
  unreadableStreak: number;
  message?: string;
  previous?: { status: string; consecutiveFailures: number; unreadableStreak: number };
}

function isUnhealthy(status: string, unreadableStreak: number): boolean {
  if (status === "auth-failed") return true;
  return status === "unreadable" && unreadableStreak >= UNREADABLE_THRESHOLD;
}

/**
 * Emit `source_unhealthy` when a source turns bad (only on the transition,
 * so a source that stays broken does not resurface every poll) and resolve
 * it on the next `ok` read. Rate limits are expected and never notify.
 *
 * @param db - Writable workspace DB connection
 * @param change - The read that was just recorded
 */
export function notifySourceHealth(
  db: Database,
  change: SourceHealthChange,
  now: () => number = Date.now,
): void {
  safely("source-health", () => {
    const groupKey = `source_unhealthy:${change.provider}:${change.sourceId}`;
    const emitter = new NotificationEmitter(db, now);
    if (change.status === "ok") {
      emitter.resolve({ kinds: ["source_unhealthy"], groupKey });
      return;
    }
    if (!isUnhealthy(change.status, change.unreadableStreak)) return;
    const previous = change.previous;
    if (previous && isUnhealthy(previous.status, previous.unreadableStreak)) return;
    const what = change.status === "auth-failed" ? "authentication failed" : "cannot be read";
    emitter.emit({
      kind: "source_unhealthy",
      severity: "high",
      groupKey,
      subject: `source:${change.provider}:${change.sourceId}`,
      title: `${change.provider} source ${change.sourceId}: ${what}`,
      body: change.message ? redactText(change.message).slice(0, 1_000) : undefined,
    });
  });
}
