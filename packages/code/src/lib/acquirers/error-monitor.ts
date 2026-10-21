/**
 * Provider-neutral error-monitor polling.
 *
 * Provider adapters normalize their native issue shape through
 * {@link ErrorMonitorProvider}. The acquirer owns lifecycle, deduplication,
 * thresholds, and dispatch so future providers (for example Datadog) do not
 * need to duplicate worker behavior.
 */

import type { TaskExecutionResult } from "./task-polling";
import type { WebhookQueue } from "../state/webhook-queue";
import type { Acquirer } from "../../worker";
import type { ErrorMonitorConfig } from "../workspace/config";
import { SentryClient } from "../observability/sentry-client";
import { SourceFetchError } from "./source-fetch";
import type {
  SourceFetchFailureStatus,
  SourceFetchOutcome,
  SourceStatusInput,
  SourceStatusSink,
} from "./source-fetch";

export { SourceFetchError };
export type {
  SourceFetchFailureStatus,
  SourceFetchOutcome,
  SourceFetchStatus,
  SourceStatusRecord,
  SourceStatusSink,
} from "./source-fetch";

/** Minimum normalized issue data needed by the shared acquirer. */
export interface ErrorMonitorIssue {
  /** Provider-stable identifier used for durable deduplication. */
  externalId: string;
  /** Human-readable identifier used in logs and task filenames. */
  displayId: string;
  title: string;
  occurrenceCount: number;
  /** Source project identifier (for example the Sentry slug) shown in pickup logs. */
  projectSlug?: string;
}

export interface IssueValidity {
  valid: boolean;
  reason?: string;
}

/** Adapter contract implemented once per error-monitoring vendor. */
export interface ErrorMonitorProvider<TIssue extends ErrorMonitorIssue> {
  readonly providerName: string;
  fetchIssues(): Promise<TIssue[]>;
  validateIssue(issue: TIssue): IssueValidity;
  buildTaskMarkdown(issue: TIssue): string;
  /** Optionally leave provider-native feedback after a terminal automation run. */
  reportAction?(issue: TIssue, succeeded: boolean): Promise<void>;
}

export interface ErrorMonitorAcquirerOptions<TIssue extends ErrorMonitorIssue> {
  sourceId: string;
  intervalSeconds: number;
  queue: WebhookQueue;
  provider: ErrorMonitorProvider<TIssue>;
  executeTask: (issue: TIssue, markdown: string) => Promise<TaskExecutionResult>;
  minOccurrences?: number;
  maxIssuesPerTick?: number;
  commentOnAction?: boolean;
  verbose?: boolean;
  /**
   * Durable per-source health sink (for example {@link AutomationStateStore}).
   * When omitted, read outcomes are only logged; the acquirer never owns the
   * sink's lifecycle.
   */
  statusStore?: SourceStatusSink;
  /** Clock override for deterministic status timestamps. */
  now?: () => number;
}

/** Build the configured vendor adapter without leaking vendor logic into the worker. */
export function createErrorMonitorProvider(
  config: ErrorMonitorConfig,
  env: Record<string, string | undefined>,
): ErrorMonitorProvider<ErrorMonitorIssue> {
  switch (config.provider) {
    case "sentry": {
      const authToken = env.SENTRY_AUTH_TOKEN;
      if (!authToken) {
        throw new Error(
          `Error monitor "${config.id}" is missing SENTRY_AUTH_TOKEN. ` +
            "Add it to the workspace, repo, team, or source env_file/env layer.",
        );
      }
      return new SentryClient({
        authToken,
        organization: config.organization,
        project: config.project,
        baseUrl: config.baseUrl,
        query: config.query,
      });
    }
  }
}

/** Shared polling acquirer for Sentry, Datadog, and future adapters. */
export class ErrorMonitorAcquirer<TIssue extends ErrorMonitorIssue> implements Acquirer {
  readonly name: string;
  private readonly options: ErrorMonitorAcquirerOptions<TIssue> & {
    minOccurrences: number;
    maxIssuesPerTick: number;
    commentOnAction: boolean;
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /** Most recent read outcome; returned while a tick is already in flight. */
  private lastOutcome: SourceFetchOutcome<TIssue> = { status: "ok", issues: [] };
  /**
   * Last status actually persisted to the sink. Used to skip redundant
   * ok-to-ok writes on every poll; failures are always persisted.
   */
  private lastPersistedStatus: SourceFetchFailureStatus | "ok" | null = null;

  constructor(options: ErrorMonitorAcquirerOptions<TIssue>) {
    this.options = {
      minOccurrences: 5,
      maxIssuesPerTick: 3,
      commentOnAction: false,
      ...options,
    };
    this.name = `errors:${options.provider.providerName}:${options.sourceId}`;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    console.log(
      `🔎 [${this.name}] polling every ${this.options.intervalSeconds}s ` +
        `(min occurrences: ${this.options.minOccurrences}, max per tick: ${this.options.maxIssuesPerTick})`,
    );
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Poll the provider once. Returns the read outcome so callers (worker,
   * dashboard, tests) can tell a quiet source from an unreadable one. A
   * failed read never marks issues processed, so the dedupe cursor cannot
   * advance past data that was not actually seen.
   */
  async tick(): Promise<SourceFetchOutcome<TIssue>> {
    if (this.busy) return this.lastOutcome;
    this.busy = true;

    const { queue, provider, minOccurrences, maxIssuesPerTick, verbose } = this.options;
    const dedupeSource = this.name;
    try {
      let issues: TIssue[];
      try {
        issues = await provider.fetchIssues();
      } catch (error) {
        return this.recordReadFailure(error);
      }
      // Only a successful read may advance health/cursor state.
      this.recordReadSuccess();
      const outcome: SourceFetchOutcome<TIssue> = { status: "ok", issues };
      this.lastOutcome = outcome;

      let handled = 0;
      for (const issue of issues) {
        if (handled >= maxIssuesPerTick) break;

        if (!Number.isFinite(issue.occurrenceCount) || issue.occurrenceCount < minOccurrences) {
          if (verbose) {
            console.log(
              `   [${this.name}] skipping ${issue.displayId}: only ${issue.occurrenceCount} occurrence(s); need ${minOccurrences}`,
            );
          }
          continue;
        }
        const validity = provider.validateIssue(issue);
        if (!validity.valid) {
          if (verbose) {
            console.log(
              `   [${this.name}] skipping ${issue.displayId}: ${validity.reason ?? "not actionable"}`,
            );
          }
          continue;
        }

        // Claim atomically before execution so competing watcher processes
        // cannot both submit the same issue. A capacity deferral is explicitly
        // unclaimed so it can run on a later tick.
        if (!queue.tryMarkProcessed(dedupeSource, issue.externalId)) continue;
        const projectLabel = issue.projectSlug ? `${issue.projectSlug} ` : "";
        console.log(
          `\n📌 [${this.name}] ${projectLabel}${issue.displayId} picked up ` +
            `(${issue.occurrenceCount} occurrences): ${issue.title}`,
        );
        const result = await this.options.executeTask(issue, provider.buildTaskMarkdown(issue));
        if (result === "deferred") {
          queue.unmarkProcessed(dedupeSource, issue.externalId);
          console.log(`⏳ [${this.name}] ${issue.displayId} deferred; it will be retried`);
          break;
        }
        handled++;
        if (result === "skipped") {
          // A retry-gate skip started no run. The issue stays claimed so it
          // does not re-enter the sweep until it changes, and reporting a
          // "failed" action comment on the vendor would be wrong.
          console.log(
            `⏭️  [${this.name}] ${issue.displayId} skipped (previous attempt reported incomplete; ticket unchanged)`,
          );
          continue;
        }
        await this.reportAction(issue, result);
        console.log(
          result
            ? `✅ [${this.name}] fix for ${issue.displayId} completed`
            : `⚠️  [${this.name}] fix for ${issue.displayId} did not complete cleanly`,
        );
      }
      return outcome;
    } catch (error) {
      // A processing failure is not a read failure: the source was readable,
      // so the read outcome stands and only this dispatch is logged.
      console.warn(`⚠️  [${this.name}] polling tick failed: ${(error as Error).message}`);
      return this.lastOutcome;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Classify a failed read, persist the per-source status, and return the
   * outcome. Callers must not mark any issue processed on this path: a source
   * that could not be read was not read, so its cursor stays put and the next
   * tick retries.
   */
  private recordReadFailure(error: unknown): SourceFetchOutcome<TIssue> {
    const failure = error instanceof SourceFetchError ? error : undefined;
    const status: SourceFetchFailureStatus = failure?.status ?? "unreadable";
    const message = failure?.message ?? (error as Error).message;
    const retryAfterMs = failure?.retryAfterMs;
    this.persistSourceStatus({
      sourceId: this.options.sourceId,
      provider: this.options.provider.providerName,
      status,
      checkedAt: this.now(),
      message,
      retryAfterMs,
    });
    const outcome: SourceFetchOutcome<TIssue> = {
      status,
      issues: [],
      error: message,
      retryAfterMs,
    };
    this.lastOutcome = outcome;
    this.logReadFailure(status, message, retryAfterMs);
    return outcome;
  }

  /** Record a successful read so health counters reset and the cursor may advance. */
  private recordReadSuccess(): void {
    // An ok source stays ok; skip the SQLite write (and WAL churn) on the
    // steady-state ok-to-ok transition. This is only an in-process hint, so a
    // source that failed and recovered is still persisted.
    if (this.lastPersistedStatus === "ok") return;
    this.persistSourceStatus({
      sourceId: this.options.sourceId,
      provider: this.options.provider.providerName,
      status: "ok",
      checkedAt: this.now(),
    });
  }

  /**
   * Persist a source health update without letting storage failures alter the
   * poll outcome. A throw here (SQLITE_BUSY after the busy timeout, disk full)
   * must never be mistaken for a read failure, escape the inner catch, or mask
   * a legitimately classified read.
   */
  private persistSourceStatus(status: SourceStatusInput): void {
    const store = this.options.statusStore;
    if (!store) return;
    try {
      store.recordSourceStatus(status);
      this.lastPersistedStatus = status.status;
    } catch (error) {
      console.warn(
        `⚠️  [${this.name}] could not persist source status: ${(error as Error).message}`,
      );
    }
  }

  /** Make an unreadable source visible instead of silently treating it as empty. */
  private logReadFailure(
    status: SourceFetchFailureStatus,
    message: string,
    retryAfterMs?: number,
  ): void {
    const retry =
      retryAfterMs !== undefined ? ` (retry in ${Math.ceil(retryAfterMs / 1000)}s)` : "";
    switch (status) {
      case "auth-failed":
        console.error(
          `🔒 [${this.name}] source is unreadable: authentication failed — ${message}. ` +
            "No issues were read; the cursor was left unchanged.",
        );
        break;
      case "rate-limited":
        console.warn(
          `⏳ [${this.name}] source is unreadable: rate-limited${retry} — ${message}. ` +
            "No issues were read; the cursor was left unchanged and the next tick will retry.",
        );
        break;
      default:
        console.warn(
          `⚠️  [${this.name}] source is unreadable: ${message}. ` +
            "No issues were read; the cursor was left unchanged and the next tick will retry.",
        );
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async reportAction(issue: TIssue, succeeded: boolean): Promise<void> {
    const { provider, commentOnAction } = this.options;
    if (!commentOnAction || !provider.reportAction) return;

    try {
      await provider.reportAction(issue, succeeded);
    } catch (error) {
      console.warn(
        `⚠️  [${this.name}] could not comment on ${issue.displayId}: ${(error as Error).message}`,
      );
    }
  }
}
