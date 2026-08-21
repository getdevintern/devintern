/**
 * Sentry error acquirer: watch a Sentry project for new error groups and turn
 * valid ones into bugfix runs.
 *
 * Each tick:
 * 1. Fetch — unresolved issues from the Sentry API (newest activity first).
 * 2. Dedupe — skip issues already handled (`processed_events`, source
 *    `sentry`); each issue id is marked before executing so a crash or a
 *    failing run never re-triggers the same error group on later ticks.
 * 3. Validate — heuristic gate (minimum event count, actionable metadata)
 *    plus an optional injected validator; the CLI pipeline's own clarity
 *    check is the final feasibility gate.
 * 4. Execute — render the issue as a markdown bugfix task and run it through
 *    the standard single-task pipeline (branch, agent, commit, PR).
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { resolveOutputDir } from "./output-dir";
import { runTaskViaCli } from "./task-polling-acquirer";
import type { SentryIssue } from "./sentry-client";
import type { WebhookQueue } from "./webhook-queue";
import type { Acquirer } from "../worker";

/** External-id prefix used in `processed_events` for Sentry issue groups. */
export const SENTRY_SOURCE = "sentry";

export interface IssueValidity {
  valid: boolean;
  reason?: string;
}

export interface SentryAcquirerOptions {
  intervalSeconds: number;
  queue: WebhookQueue;
  /** Fetch step: current unresolved issues (injected for tests). */
  fetchIssues: () => Promise<SentryIssue[]>;
  /**
   * Extra validity gate beyond the heuristics (e.g. an agent assessment).
   * Return false (or `{ valid: false }`) to skip an issue without marking it
   * processed, so it can be retried once it becomes valid.
   */
  validateIssue?: (
    issue: SentryIssue,
  ) => IssueValidity | boolean | Promise<IssueValidity | boolean>;
  /** Execute step: create the bugfix for one issue; returns success. */
  createBugfix: (issue: SentryIssue) => Promise<boolean>;
  /** Minimum event count for an issue to be considered valid (default 5). */
  minEvents?: number;
  /** Max issues handled per tick (default 3). */
  maxIssuesPerTick?: number;
  verbose?: boolean;
}

/**
 * Heuristic validity gate applied before any injected validator.
 *
 * An issue is considered valid when it has enough occurrences to rule out a
 * one-off blip and carries enough context (title plus culprit or exception
 * type) for the agent to locate the failure.
 */
export function isIssueValid(issue: SentryIssue, minEvents: number): IssueValidity {
  const events = Number(issue.count);
  if (!Number.isFinite(events) || events < minEvents) {
    return { valid: false, reason: `only ${issue.count} event(s); need ${minEvents}` };
  }
  if (!issue.title.trim()) {
    return { valid: false, reason: "missing error title" };
  }
  if (!issue.culprit && !issue.metadata?.type && !issue.metadata?.filename) {
    return { valid: false, reason: "no culprit or exception metadata to locate the error" };
  }
  return { valid: true };
}

/**
 * Render a Sentry issue as a markdown bugfix task description.
 *
 * @param issue - The Sentry issue group to fix
 */
export function buildBugfixTaskMarkdown(issue: SentryIssue): string {
  const lines = [
    `# Fix Sentry error ${issue.shortId}`,
    "",
    `## Error`,
    "",
    `- **Title**: ${issue.title}`,
    `- **Sentry ID**: ${issue.shortId} (${issue.id})`,
    `- **Level**: ${issue.level ?? "error"}`,
    `- **Events**: ${issue.count}`,
    `- **First seen**: ${issue.firstSeen}`,
    `- **Last seen**: ${issue.lastSeen}`,
    `- **Link**: ${issue.permalink}`,
  ];
  if (issue.culprit) {
    lines.push(`- **Culprit**: ${issue.culprit}`);
  }
  if (issue.metadata?.type) {
    lines.push(`- **Exception type**: ${issue.metadata.type}`);
  }
  if (issue.metadata?.value) {
    lines.push(`- **Exception message**: ${issue.metadata.value}`);
  }
  if (issue.metadata?.filename) {
    lines.push(`- **File**: ${issue.metadata.filename}`);
  }
  lines.push(
    "",
    `## Task`,
    "",
    "Reproduce the root cause of this error from the details above, implement the",
    "minimal fix in this repository, and add or adjust tests covering the failure",
    "path. Do not change unrelated behavior.",
    "",
  );
  return lines.join("\n");
}

/**
 * Default execute step: write the bugfix task to the output directory and run
 * it through the standard CLI pipeline as a local markdown task.
 *
 * @param issue - The Sentry issue group to fix
 * @returns true when the CLI exited 0
 */
export async function runSentryBugfixViaCli(issue: SentryIssue): Promise<boolean> {
  const dir = join(resolveOutputDir(), "sentry-bugfixes");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${issue.shortId.replace(/[^a-zA-Z0-9_-]/g, "-")}.md`);
  writeFileSync(file, buildBugfixTaskMarkdown(issue));
  return runTaskViaCli(file);
}

/** Polling acquirer for Sentry error groups. */
export class SentryErrorAcquirer implements Acquirer {
  readonly name = "sentry";
  private options: Required<Pick<SentryAcquirerOptions, "minEvents" | "maxIssuesPerTick">> &
    SentryAcquirerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(options: SentryAcquirerOptions) {
    this.options = {
      minEvents: 5,
      maxIssuesPerTick: 3,
      ...options,
    };
  }

  /** Start polling: immediate first tick, then on the configured interval. */
  async start(): Promise<void> {
    console.log(
      `🔎 Watching Sentry errors every ${this.options.intervalSeconds}s ` +
        `(min events: ${this.options.minEvents}, max per tick: ${this.options.maxIssuesPerTick})`,
    );
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalSeconds * 1000);
  }

  /** Stop polling (an in-flight tick finishes). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One fetch → dedupe → validate → execute cycle. Skipped while busy. */
  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;

    const {
      queue,
      fetchIssues,
      validateIssue,
      createBugfix,
      minEvents,
      maxIssuesPerTick,
      verbose,
    } = this.options;
    try {
      const issues = await fetchIssues();

      let handled = 0;
      for (const issue of issues) {
        if (handled >= maxIssuesPerTick) {
          break;
        }

        // Dedupe: one bugfix attempt per error group, ever. Marked before
        // executing so a failing run does not loop every tick.
        const externalId = `issue:${issue.id}`;
        if (queue.hasProcessed(SENTRY_SOURCE, externalId)) {
          continue;
        }

        const heuristic = isIssueValid(issue, minEvents);
        if (!heuristic.valid) {
          if (verbose) {
            console.log(`   [${this.name}] skipping ${issue.shortId}: ${heuristic.reason}`);
          }
          continue;
        }

        if (validateIssue) {
          const verdict = await validateIssue(issue);
          const valid = typeof verdict === "boolean" ? verdict : verdict.valid;
          if (!valid) {
            const reason = typeof verdict === "object" ? verdict.reason : undefined;
            if (verbose) {
              console.log(`   [${this.name}] skipping ${issue.shortId}: ${reason || "not valid"}`);
            }
            continue;
          }
        }

        queue.markProcessed(SENTRY_SOURCE, externalId);

        console.log(`\n📌 [${this.name}] new error ${issue.shortId}: ${issue.title}`);
        const ok = await createBugfix(issue);
        handled++;
        console.log(
          ok
            ? `✅ [${this.name}] bugfix for ${issue.shortId} completed`
            : `⚠️  [${this.name}] bugfix for ${issue.shortId} did not complete cleanly`,
        );
      }
    } catch (error) {
      console.warn(`⚠️  [${this.name}] polling tick failed: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
