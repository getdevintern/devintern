/**
 * CI failure watcher acquirer (worker Mode 1, Tier 1): watch GitHub Actions
 * check runs and commit statuses on the agent's own PRs and auto-fix
 * failures, closing the loop from "agent opened PR" to "PR green".
 *
 * Each tick, for every open PR in the `agent_prs` registry:
 * 1. Conditional GET on the PR itself — closed/merged PRs leave the watch
 *    list; fork PRs are skipped gracefully (Actions rarely runs there).
 * 2. ETag-cached conditional GETs on the head SHA's check runs and combined
 *    commit status. Only terminal `failure` conclusions are actionable —
 *    the agent's own pushes constantly re-run CI as `in_progress`.
 * 3. When a new failure appears, fetch the failing jobs' logs (with a
 *    check-run annotation fallback), truncate them to the error-relevant
 *    tail, and run `devintern address-review --ci-feedback <file>` as a CLI
 *    subprocess — reusing the whole review pipeline (worktree prep,
 *    sandboxed agent spawn, commit/push with hook retries).
 *
 * Guardrails:
 * - Successfully handled failures dedupe per `headSha + checkRunId` via
 *   `processed_events`, while failed/no-op agent invocations remain eligible
 *   for retry across worker restarts.
 * - Consecutive failed autofix attempts per PR are capped (`CI_FIX_MAX_
 *   ATTEMPTS`, default 3). On exhaustion the watcher posts an escalation
 *   comment and stops retrying until the head moves again (a human push) —
 *   or CI passes, which resets the budget outright.
 */

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

import type { WebhookQueue } from "./webhook-queue";
import type { WorkerState } from "./worker-state";
import type { Acquirer } from "../worker";
import type { CiFailureFeedback } from "./review-formatter";
import { serializePrRun } from "./review-polling-acquirer";

export interface PolledCiPr {
  state: string;
  head?: {
    sha: string;
    /** Head repository; differs from the base repo for fork PRs. */
    repo?: { full_name: string } | null;
  };
}

export interface WatchedCheckRun {
  id: number;
  name: string;
  /** `queued`, `in_progress`, or `completed`. */
  status: string;
  /** Terminal outcome; null while still executing. */
  conclusion: string | null;
  details_url?: string;
}

export interface WatchedStatusState {
  state: string;
  total_count: number;
  statuses: Array<{ id: number; state: string; context?: string; target_url?: string | null }>;
}

/** GitHub access used by the watcher (injected for tests). */
export interface CiFailureWatcherGitHub {
  fetchPr(repo: string, prNumber: number, etag?: string): Promise<CiConditionalResult<PolledCiPr>>;
  fetchCheckRuns(
    repo: string,
    sha: string,
    etag?: string,
  ): Promise<CiConditionalResult<WatchedCheckRun[]>>;
  fetchCommitStatus(
    repo: string,
    sha: string,
    etag?: string,
  ): Promise<CiConditionalResult<WatchedStatusState>>;
  /**
   * Fetch raw log text of the failing Actions jobs for a SHA (workflow runs
   * → jobs → `logs_url`). Returns null on 403/404/scope problems.
   */
  fetchFailingJobLogs(repo: string, sha: string): Promise<string | null>;
  /**
   * Fallback details for one check run when job logs are unavailable:
   * its annotations rendered as text. Returns null when unsupported.
   */
  fetchCheckRunDetails?(repo: string, checkRunId: number): Promise<string | null>;
  /** Best-effort escalation comment on the PR conversation. */
  postComment(repo: string, prNumber: number, body: string): Promise<void>;
}

export interface CiConditionalResult<T> {
  data: T | null;
  etag?: string;
  notModified: boolean;
}

export interface CiFailureWatcherAcquirerOptions {
  intervalSeconds: number;
  workerState: WorkerState;
  queue: WebhookQueue;
  github: CiFailureWatcherGitHub;
  /**
   * Fix CI failures on one PR given a feedback JSON path (injected for
   * tests). Resolves success when the fix was committed and pushed.
   */
  fixPr: (repo: string, prNumber: number, feedbackPath: string) => Promise<boolean>;
  /** Max consecutive failed autofix attempts per PR (default 3). */
  maxAttempts?: number;
  /** Live workspace switch; false suppresses all GitHub polling and fixes. */
  enabled?: () => boolean;
  verbose?: boolean;
}

/** Dedupe source for CI failures (keyed by head SHA + check run/status id). */
const SOURCE = "github:ci";

/** Cursor source prefixes persisted per watched PR. */
const PR_CURSOR_PREFIX = "github:cipr:";
const CHECKS_CURSOR_PREFIX = "github:cichecks:";
const STATUS_CURSOR_PREFIX = "github:cistatus:";

/** Default consecutive-attempt cap per PR (`CI_FIX_MAX_ATTEMPTS` override). */
export const DEFAULT_CI_FIX_MAX_ATTEMPTS = 3;

/** Log excerpt limits: raw CI logs can be megabytes. */
const LOG_MAX_LINES = 200;
const LOG_CONTEXT_LINES = 5;
const LOG_MAX_CHARS = 16_000;

/** ANSI escape sequences (colors/cursor control) polluting CI logs. */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][0-9;]*[A-Za-z]/g;

/**
 * Strip ANSI codes and reduce raw CI logs to the failure-relevant tail.
 *
 * Error lines are located across the WHOLE log (an error at the top of a
 * multi-thousand-line build log is still the root cause) and kept with
 * surrounding context, together with an always-included tail window. The
 * result is capped at {@value LOG_MAX_CHARS} chars so the agent's context
 * cannot be blown by a multi-megabyte build log.
 *
 * @param raw - Raw job-log text (may be empty/null)
 * @param options - Line/char limits (overridable for tests)
 * @returns Truncated excerpt, or `null` when there is nothing to show
 */
export function truncateCiLogs(
  raw: string | null | undefined,
  options: {
    maxLines?: number;
    contextLines?: number;
    maxChars?: number;
  } = {},
): string | null {
  if (!raw || !raw.trim()) {
    return null;
  }

  const maxLines = options.maxLines ?? LOG_MAX_LINES;
  const contextLines = options.contextLines ?? LOG_CONTEXT_LINES;
  const maxChars = options.maxChars ?? LOG_MAX_CHARS;

  const clean = raw.replace(ANSI_PATTERN, "").replace(/\r\n/g, "\n");
  const lines = clean.split("\n");

  const errorPattern =
    /(##\[error\])|(\berror\b)|(\bfail(ed|ure|ing)?\b)|(exception)|(assertion)|(✗)|(✘)|(exit code [1-9])/i;
  const keep = new Set<number>();
  const tailStart = Math.max(0, lines.length - Math.min(maxLines, 60));
  for (let i = tailStart; i < lines.length; i++) {
    keep.add(i);
  }
  for (let i = 0; i < lines.length; i++) {
    if (!errorPattern.test(lines[i])) {
      continue;
    }
    for (
      let j = Math.max(0, i - contextLines);
      j <= Math.min(lines.length - 1, i + contextLines);
      j++
    ) {
      keep.add(j);
    }
  }

  const keptIndices = [...keep].sort((a, b) => a - b);
  const parts: string[] = [];
  let previous = -2;
  for (const index of keptIndices) {
    if (index !== previous + 1 && parts.length > 0) {
      parts.push("...");
    }
    parts.push(lines[index]);
    previous = index;
  }
  let excerpt = parts.join("\n");

  if (excerpt.length > maxChars) {
    excerpt = `...\n${excerpt.slice(-maxChars)}`;
  }
  return excerpt.trim() ? excerpt : null;
}

/**
 * Run `devintern address-review <pr-url> --ci-feedback <file>` as a CLI
 * subprocess, reusing the manual flow (worktree, sandboxed agent, commit,
 * push). The feedback JSON carries failing-check metadata and the truncated
 * log excerpt.
 *
 * @param repo - `owner/repo` slug
 * @param prNumber - Pull request number
 * @param feedbackPath - Path to the CI feedback JSON file
 * @param opts - Working directory and environment for the subprocess;
 *               the workspace worker runs from the repo's base worktree
 *               with its composed per-repo environment
 */
export function runCiFixViaCli(
  repo: string,
  prNumber: number,
  feedbackPath: string,
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<boolean> {
  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  return serializePrRun(
    repo,
    prNumber,
    () =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [process.argv[1], "address-review", prUrl, "--ci-feedback", feedbackPath],
          {
            stdio: "inherit",
            cwd: opts.cwd,
            env: opts.env ?? process.env,
          },
        );
        child.on("close", (code) => resolve(code === 0));
        child.on("error", (error) => {
          console.error(`❌ Failed to spawn ci-fix for ${prUrl}: ${error.message}`);
          resolve(false);
        });
      }),
  );
}

interface PendingFailure {
  externalId: string;
  name: string;
  conclusion: string | null;
  detailsUrl?: string;
  checkRunId?: number;
}

type CiAggregateState = "unknown" | "empty" | "pending" | "success" | "failure";

interface CachedCiSnapshot {
  sha: string;
  state: CiAggregateState;
  failures: PendingFailure[];
}

function parseSnapshot(value?: string): CachedCiSnapshot | null {
  if (!value?.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value) as CachedCiSnapshot;
    return parsed && typeof parsed.sha === "string" && Array.isArray(parsed.failures)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Watches CI on the agent's own PRs and triggers autofix runs.
 */
export class CiFailureWatcherAcquirer implements Acquirer {
  readonly name = "poll:ci-failures";
  private options: CiFailureWatcherAcquirerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(options: CiFailureWatcherAcquirerOptions) {
    this.options = {
      ...options,
      maxAttempts: options.maxAttempts ?? parseMaxAttemptsFromEnv(),
    };
  }

  /** Start watching: immediate first tick, then on the configured interval. */
  async start(): Promise<void> {
    const enabled = this.options.enabled?.() ?? true;
    console.log(
      `${enabled ? "🤖" : "⏸️ "} CI failure fixes ${enabled ? "enabled" : "disabled"}; ` +
        `poll interval ${this.options.intervalSeconds}s ` +
        `(watching ${this.options.workerState.listOpenAgentPrs().length} open PR(s))`,
    );
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalSeconds * 1000);
  }

  /** Stop watching (an in-flight tick finishes its current PR). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Apply a live workspace poll-interval change. */
  updateInterval(seconds: number): void {
    this.options.intervalSeconds = seconds;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
  }

  /** One polling cycle over all watched PRs. Skipped while busy. */
  async tick(): Promise<void> {
    if (this.busy || !(this.options.enabled?.() ?? true)) {
      return;
    }
    this.busy = true;

    try {
      for (const pr of this.options.workerState.listOpenAgentPrs()) {
        try {
          await this.pollPr(pr.repo, pr.prNumber);
        } catch (error) {
          console.warn(
            `⚠️  [${this.name}] polling ${pr.repo}#${pr.prNumber} failed: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Poll a single PR; triggers at most one fix attempt per poll. */
  private async pollPr(repo: string, prNumber: number): Promise<void> {
    const { workerState, github, verbose } = this.options;

    // 1. PR state (ETag-cached): unwatch closed/merged PRs, track head SHA.
    const prSource = `${PR_CURSOR_PREFIX}${repo}#${prNumber}`;
    const prCursor = workerState.getCursor(prSource);
    const prResult = await github.fetchPr(repo, prNumber, prCursor?.etag);
    if ((prResult as CiConditionalResult<PolledCiPr> & { gone?: boolean }).gone) {
      workerState.markAgentPrClosed(repo, prNumber);
      return;
    }
    if (!prResult.notModified) {
      if (prResult.etag) {
        workerState.setCursor(prSource, prResult.data?.head?.sha ?? "", prResult.etag);
      }
      if (prResult.data && prResult.data.state !== "open") {
        console.log(`👁️  [${this.name}] ${repo}#${prNumber} is ${prResult.data.state}; unwatching`);
        workerState.markAgentPrClosed(repo, prNumber);
        return;
      }
    }

    const headSha = prResult.notModified ? prCursor?.cursorValue : prResult.data?.head?.sha;
    if (!headSha) {
      return;
    }

    // Fork PRs: check runs live on the head repo and Actions usually does not
    // run there. Skip quietly instead of burning requests or commenting.
    const headRepo = prResult.data?.head?.repo?.full_name;
    if (headRepo && headRepo.toLowerCase() !== repo.toLowerCase()) {
      if (verbose) {
        console.log(`   [${this.name}] ${repo}#${prNumber} is a fork PR (${headRepo}); skipping`);
      }
      return;
    }

    const pending: PendingFailure[] = [];
    let checksState: CiAggregateState = "unknown";
    let statusState: CiAggregateState = "unknown";

    // 2. Check runs (ETag-cached): terminal failures only.
    const checksSource = `${CHECKS_CURSOR_PREFIX}${repo}#${prNumber}`;
    const checksCursor = workerState.getCursor(checksSource);
    const cachedChecks = parseSnapshot(checksCursor?.cursorValue);
    const checksResult = await github.fetchCheckRuns(
      repo,
      headSha,
      cachedChecks?.sha === headSha ? checksCursor?.etag : undefined,
    );
    if (checksResult.notModified && cachedChecks?.sha === headSha) {
      checksState = cachedChecks.state;
      pending.push(...cachedChecks.failures);
    }
    if (!checksResult.notModified && checksResult.data) {
      let sawCheckSuccess = false;
      let sawCheckPending = false;
      const checkFailures: PendingFailure[] = [];
      for (const check of checksResult.data) {
        if (check.status !== "completed") {
          sawCheckPending = true;
          continue;
        }
        if (check.conclusion === "success") {
          sawCheckSuccess = true;
          continue;
        }
        if (check.conclusion !== "failure" && check.conclusion !== "timed_out") {
          continue;
        }
        checkFailures.push({
          externalId: `check:${repo}#${prNumber}:${headSha}:${check.id}`,
          name: check.name,
          conclusion: check.conclusion,
          detailsUrl: check.details_url,
          checkRunId: check.id,
        });
      }
      checksState =
        checkFailures.length > 0
          ? "failure"
          : sawCheckPending
            ? "pending"
            : checksResult.data.length === 0
              ? "empty"
              : sawCheckSuccess || checksResult.data.every((check) => check.status === "completed")
                ? "success"
                : "unknown";
      pending.push(...checkFailures);
      workerState.setCursor(
        checksSource,
        JSON.stringify({ sha: headSha, state: checksState, failures: checkFailures }),
        checksResult.etag,
      );
    }

    // 3. Combined commit status (ETag-cached): non-Actions reporters.
    const statusSource = `${STATUS_CURSOR_PREFIX}${repo}#${prNumber}`;
    const statusCursor = workerState.getCursor(statusSource);
    const cachedStatus = parseSnapshot(statusCursor?.cursorValue);
    const statusResult = await github.fetchCommitStatus(
      repo,
      headSha,
      cachedStatus?.sha === headSha ? statusCursor?.etag : undefined,
    );
    if (statusResult.notModified && cachedStatus?.sha === headSha) {
      statusState = cachedStatus.state;
      pending.push(...cachedStatus.failures);
    }
    if (!statusResult.notModified && statusResult.data) {
      const statusFailures: PendingFailure[] = [];
      for (const status of statusResult.data.statuses) {
        if (status.state !== "failure" && status.state !== "error") {
          continue;
        }
        statusFailures.push({
          externalId: `check:${repo}#${prNumber}:${headSha}:status:${status.context ?? status.id}`,
          name: status.context ?? `commit-status-${status.id}`,
          conclusion: status.state,
          detailsUrl: status.target_url ?? undefined,
        });
      }
      statusState =
        statusFailures.length > 0
          ? "failure"
          : statusResult.data.total_count === 0
            ? "empty"
            : statusResult.data.state === "pending"
              ? "pending"
              : statusResult.data.state === "success"
                ? "success"
                : "unknown";
      pending.push(...statusFailures);
      workerState.setCursor(
        statusSource,
        JSON.stringify({ sha: headSha, state: statusState, failures: statusFailures }),
        statusResult.etag,
      );
    }

    // Fully green observation: zero the attempt counter. A mixed result
    // (some checks pass, others fail) must NOT keep refunding the budget.
    const fullyGreen =
      pending.length === 0 &&
      (checksState === "success" || checksState === "empty") &&
      (statusState === "success" || statusState === "empty") &&
      (checksState === "success" || statusState === "success");
    if (fullyGreen) {
      this.resetRetryBudget(repo, prNumber, "CI passed");
    }

    // 4. Split failures into fresh vs already-handled. Mark only after a
    // successful invocation so crashes/no-op runs remain retryable.
    const fresh: PendingFailure[] = [];
    for (const failure of pending) {
      if (!this.options.queue.hasProcessed(SOURCE, failure.externalId)) {
        fresh.push(failure);
      }
    }
    if (pending.length === 0) {
      return;
    }

    // 5. Retry cap & escalation bookkeeping — evaluated on every observation
    // (fresh or not), so exhaustion escalates even when the failing run was
    // already handled but the fix attempt produced no new CI run.
    const state = workerState.getCiFixState(repo, prNumber);
    if (
      state.escalatedSha &&
      state.escalatedSha !== headSha &&
      state.consecutiveFailures >= this.maxAttempts
    ) {
      // Head moved past the escalation point: someone (presumably a human)
      // pushed. Grant a fresh budget.
      console.log(
        `♻️  [${this.name}] ${repo}#${prNumber}: head moved past escalation point; retrying CI fixes`,
      );
      state.consecutiveFailures = 0;
      state.escalatedSha = undefined;
      workerState.setCiFixState(repo, prNumber, state);
    }

    if (state.consecutiveFailures >= this.maxAttempts) {
      if (!state.escalatedSha && fresh.length > 0) {
        state.escalatedSha = headSha;
        workerState.setCiFixState(repo, prNumber, state);
        await this.escalateToHuman(repo, prNumber, pending);
      } else if (verbose) {
        console.log(
          `   [${this.name}] ${repo}#${prNumber}: retry budget exhausted; waiting for human`,
        );
      }
      return;
    }

    if (fresh.length === 0) {
      return;
    }

    console.log(
      `\n🤖 [${this.name}] CI failure(s) on ${repo}#${prNumber} @ ${headSha.slice(0, 7)}: ` +
        fresh.map((f) => f.name).join(", "),
    );

    // 6. Gather failure-relevant logs and run one fix attempt.
    const logs = await this.collectLogs(repo, headSha, fresh);
    const feedback: CiFailureFeedback = {
      repository: repo,
      prNumber,
      branch: undefined,
      failures: fresh.map((f) => ({
        name: f.name,
        conclusion: f.conclusion,
        detailsUrl: f.detailsUrl,
      })),
      logs,
    };

    const feedbackDir = mkdtempSync(join(tmpdir(), "devintern-ci-fix-"));
    const feedbackPath = join(feedbackDir, "ci-feedback.json");
    writeFileSync(feedbackPath, JSON.stringify(feedback));

    try {
      let ok = false;
      try {
        ok = await this.options.fixPr(repo, prNumber, feedbackPath);
      } catch (error) {
        console.warn(`⚠️  [${this.name}] CI fix invocation failed: ${(error as Error).message}`);
      }
      state.consecutiveFailures += 1;
      if (ok) {
        for (const failure of fresh) this.options.queue.markProcessed(SOURCE, failure.externalId);
      }
      if (!ok && state.consecutiveFailures >= this.maxAttempts && !state.escalatedSha) {
        state.escalatedSha = headSha;
        await this.escalateToHuman(repo, prNumber, pending);
      }
      workerState.setCiFixState(repo, prNumber, state);
      console.log(
        ok
          ? `✅ [${this.name}] ${repo}#${prNumber} CI fix pushed (attempt ` +
              `${state.consecutiveFailures}/${this.maxAttempts})`
          : `⚠️  [${this.name}] ${repo}#${prNumber} CI fix attempt did not complete`,
      );
    } finally {
      rmSync(feedbackDir, { recursive: true, force: true });
    }
  }

  /** Job logs first; fall back to check-run annotations per failing check. */
  private async collectLogs(
    repo: string,
    headSha: string,
    failures: PendingFailure[],
  ): Promise<string | null> {
    const { github, verbose } = this.options;

    let rawLogs: string | null = null;
    try {
      rawLogs = await github.fetchFailingJobLogs(repo, headSha);
    } catch (error) {
      if (verbose) {
        console.warn(`   ⚠️  [${this.name}] job log fetch failed: ${(error as Error).message}`);
      }
    }

    const excerpt = truncateCiLogs(rawLogs);
    if (excerpt) {
      return excerpt;
    }

    // Annotations fallback (also covers non-Actions statuses via details URL).
    const snippets: string[] = [];
    for (const failure of failures) {
      const match =
        failure.detailsUrl?.match(/checks\/(\d+)/) ??
        failure.detailsUrl?.match(/check-runs\/(\d+)/);
      const checkRunId = failure.checkRunId ?? (match ? parseInt(match[1], 10) : NaN);
      if (!github.fetchCheckRunDetails || Number.isNaN(checkRunId)) {
        continue;
      }
      try {
        const detail = await github.fetchCheckRunDetails(repo, checkRunId);
        if (detail) {
          snippets.push(detail);
        }
      } catch {
        // Details are best-effort only.
      }
    }
    const annotationExcerpt = truncateCiLogs(snippets.join("\n") || null);
    if (annotationExcerpt) {
      return annotationExcerpt;
    }

    console.warn(
      `⚠️  [${this.name}] ${repo}: could not fetch logs (scope/fork?); proceeding without them`,
    );
    return null;
  }

  /** Zero the attempt counter because CI went green. */
  private resetRetryBudget(repo: string, prNumber: number, reason: string): void {
    const state = this.options.workerState.getCiFixState(repo, prNumber);
    if (state.consecutiveFailures > 0 || state.escalatedSha) {
      console.log(`💚 [${this.name}] ${repo}#${prNumber}: ${reason}; resetting CI fix counter`);
      this.options.workerState.setCiFixState(repo, prNumber, {
        consecutiveFailures: 0,
        escalatedSha: undefined,
      });
    }
  }

  /** Post the give-up comment and freeze further attempts until head moves. */
  private async escalateToHuman(
    repo: string,
    prNumber: number,
    failures: PendingFailure[],
  ): Promise<void> {
    const names = failures.map((f) => `- ${f.name}`).join("\n");
    const body =
      "⚠️ I could not fix the following CI failure(s) automatically after " +
      `${this.maxAttempts} attempt(s):\n\n${names}\n\n` +
      "I have stopped retrying to avoid churn. Push a new commit (or mention me) " +
      "and I will take another look.";
    try {
      await this.options.github.postComment(repo, prNumber, body);
      console.log(
        `📣 [${this.name}] ${repo}#${prNumber}: posted escalation comment after ` +
          `${this.maxAttempts} failed attempt(s)`,
      );
    } catch (error) {
      console.warn(
        `⚠️  [${this.name}] could not post escalation comment on ${repo}#${prNumber}: ` +
          `${(error as Error).message}`,
      );
    }
  }

  private get maxAttempts(): number {
    return this.options.maxAttempts ?? DEFAULT_CI_FIX_MAX_ATTEMPTS;
  }
}

/** Read `CI_FIX_MAX_ATTEMPTS` (default {@link DEFAULT_CI_FIX_MAX_ATTEMPTS}). */
function parseMaxAttemptsFromEnv(): number {
  const parsed = parseInt(process.env.CI_FIX_MAX_ATTEMPTS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CI_FIX_MAX_ATTEMPTS;
}
