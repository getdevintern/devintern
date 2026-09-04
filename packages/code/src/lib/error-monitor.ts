/**
 * Provider-neutral error-monitor polling.
 *
 * Provider adapters normalize their native issue shape through
 * {@link ErrorMonitorProvider}. The acquirer owns lifecycle, deduplication,
 * thresholds, and dispatch so future providers (for example Datadog) do not
 * need to duplicate worker behavior.
 */

import type { TaskExecutionResult } from "./task-polling-acquirer";
import type { WebhookQueue } from "./webhook-queue";
import type { Acquirer } from "../worker";
import type { ErrorMonitorConfig } from "./workspace/config";
import { SentryClient } from "./sentry-client";

/** Minimum normalized issue data needed by the shared acquirer. */
export interface ErrorMonitorIssue {
  /** Provider-stable identifier used for durable deduplication. */
  externalId: string;
  /** Human-readable identifier used in logs and task filenames. */
  displayId: string;
  title: string;
  occurrenceCount: number;
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
}

export interface ErrorMonitorAcquirerOptions<TIssue extends ErrorMonitorIssue> {
  sourceId: string;
  intervalSeconds: number;
  queue: WebhookQueue;
  provider: ErrorMonitorProvider<TIssue>;
  executeTask: (issue: TIssue, markdown: string) => Promise<TaskExecutionResult>;
  minOccurrences?: number;
  maxIssuesPerTick?: number;
  verbose?: boolean;
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
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(options: ErrorMonitorAcquirerOptions<TIssue>) {
    this.options = { minOccurrences: 5, maxIssuesPerTick: 3, ...options };
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

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;

    const { queue, provider, minOccurrences, maxIssuesPerTick, verbose } = this.options;
    const dedupeSource = this.name;
    try {
      const issues = await provider.fetchIssues();
      let handled = 0;
      for (const issue of issues) {
        if (handled >= maxIssuesPerTick) break;
        if (queue.hasProcessed(dedupeSource, issue.externalId)) continue;

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

        // Claim before execution so overlapping ticks/process restarts cannot
        // start the same fix twice. A capacity deferral is explicitly
        // unclaimed so it can run on a later tick.
        queue.markProcessed(dedupeSource, issue.externalId);
        console.log(`\n📌 [${this.name}] ${issue.displayId}: ${issue.title}`);
        const result = await this.options.executeTask(issue, provider.buildTaskMarkdown(issue));
        if (result === "deferred") {
          queue.unmarkProcessed(dedupeSource, issue.externalId);
          console.log(`⏳ [${this.name}] ${issue.displayId} deferred; it will be retried`);
          break;
        }
        handled++;
        console.log(
          result
            ? `✅ [${this.name}] fix for ${issue.displayId} completed`
            : `⚠️  [${this.name}] fix for ${issue.displayId} did not complete cleanly`,
        );
      }
    } catch (error) {
      console.warn(`⚠️  [${this.name}] polling tick failed: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
