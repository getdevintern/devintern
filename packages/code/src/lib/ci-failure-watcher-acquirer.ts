/**
 * CI failure watcher acquirer (worker Mode 1, Tier 1): watch GitHub Actions
 * workflow runs and commit statuses on the agent's own PRs and auto-fix
 * failures, closing the loop from "agent opened PR" to "PR green".
 *
 * Each tick, for every open PR in the `agent_prs` registry:
 * 1. Conditional GET on the PR itself — closed/merged PRs leave the watch
 *    list; fork PRs are skipped gracefully (Actions rarely runs there).
 * 2. ETag-cached conditional GETs on the head SHA's Actions runs and combined
 *    commit status. Only terminal `failure` conclusions are actionable —
 *    the agent's own pushes constantly re-run CI as `in_progress`.
 *    Pending, failing, and not-yet-reported CI stays on the workspace cadence;
 *    unchanged terminal-green PRs progressively back off to 5, 15, then 30
 *    minutes. Any observed PR or CI change restores the fast cadence.
 * 3. When a new failure appears, fetch the failing jobs' logs, truncate them
 *    to the error-relevant tail, and run
 *    `devintern address-review --ci-feedback <file>` as a CLI
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

export interface WatchedWorkflowRun {
  id: number;
  /** Provider-native durable identifier when a numeric run id is insufficient. */
  externalId?: string;
  name?: string;
  /** `queued`, `in_progress`, `waiting`, or `completed`. */
  status: string;
  /** Terminal outcome; null while still executing. */
  conclusion: string | null;
  html_url?: string;
}

export interface WatchedStatusState {
  state: string;
  total_count: number;
  statuses: Array<{ id: number; state: string; context?: string; target_url?: string | null }>;
}

/** GitHub access used by the watcher (injected for tests). */
export interface CiFailureWatcherGitHub {
  fetchPr(repo: string, prNumber: number, etag?: string): Promise<CiConditionalResult<PolledCiPr>>;
  fetchWorkflowRuns(
    repo: string,
    sha: string,
    etag?: string,
  ): Promise<CiConditionalResult<WatchedWorkflowRun[]>>;
  fetchCommitStatus(
    repo: string,
    sha: string,
    etag?: string,
  ): Promise<CiConditionalResult<WatchedStatusState>>;
  /**
   * Fetch raw log text of the failing Actions jobs for a SHA (workflow runs
   * → jobs → job-log endpoint). Returns null on 403/404/scope problems.
   */
  fetchFailingJobLogs(repo: string, sha: string): Promise<string | null>;
  /** Best-effort escalation comment on the PR conversation. */
  postComment(repo: string, prNumber: number, body: string): Promise<void>;
}

export interface CiConditionalResult<T> {
  data: T | null;
  etag?: string;
  notModified: boolean;
}

/** Outcome of requesting one CI repair from the workspace executor. */
export type CiFixResult = boolean | "deferred";

export interface CiFailureWatcherAcquirerOptions {
  intervalSeconds: number;
  workerState: WorkerState;
  queue: WebhookQueue;
  github: CiFailureWatcherGitHub;
  /**
   * Fix CI failures on one PR given a feedback JSON path (injected for
   * tests). Resolves success when the fix was committed and pushed.
   */
  fixPr: (
    repo: string,
    prNumber: number,
    feedbackPath: string,
    expectedHeadSha: string,
  ) => Promise<CiFixResult>;
  /** Max consecutive failed autofix attempts per PR (default 3). */
  maxAttempts?: number;
  /** Live workspace switch; false suppresses all GitHub polling and fixes. */
  enabled?: () => boolean;
  /** Clock override for deterministic scheduling tests. */
  now?: () => number;
  verbose?: boolean;
  /** Optional provider-specific watch list; defaults to registered GitHub PRs. */
  watchedChanges?: () => Array<{ repo: string; prNumber: number }>;
  /** Optional provider-specific close operation. */
  markClosed?: (repo: string, prNumber: number) => void;
  /** Durable key namespace; defaults to `github`. */
  namespace?: string;
  /** Human-readable provider label used for missing-log diagnostics. */
  ciProviderLabel?: string;
  /** Provider-native display reference, for example `group/project!17`. */
  describeChange?: (repo: string, prNumber: number) => string;
  /** Provider-native project path stored in CI feedback. */
  feedbackRepository?: (repo: string) => string;
  /** Recovery sentence appended to the exhausted-attempt comment. */
  escalationRecoveryText?: string;
}

/** Dedupe source for CI failures (keyed by head SHA + workflow run/status id). */
const SOURCE = "github:ci";

/** Default consecutive-attempt cap per PR (`CI_FIX_MAX_ATTEMPTS` override). */
export const DEFAULT_CI_FIX_MAX_ATTEMPTS = 3;

/** Poll delays for PRs whose terminal-green CI remains unchanged. */
export const CI_GREEN_BACKOFF_SECONDS = [5 * 60, 15 * 60, 30 * 60] as const;

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
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    webUrl?: string;
    serializationKey?: string;
    expectedHeadSha?: string;
    signal?: AbortSignal;
  } = {},
): Promise<boolean> {
  const prUrl = opts.webUrl ?? `https://github.com/${repo}/pull/${prNumber}`;
  return serializePrRun(
    opts.serializationKey ?? repo,
    prNumber,
    () =>
      new Promise((resolve) => {
        if (opts.signal?.aborted) {
          resolve(false);
          return;
        }
        const detached = process.platform !== "win32";
        const child = spawn(
          process.execPath,
          [
            process.argv[1],
            "address-review",
            prUrl,
            "--ci-feedback",
            feedbackPath,
            ...(opts.expectedHeadSha ? ["--expected-head", opts.expectedHeadSha] : []),
          ],
          {
            stdio: "inherit",
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            detached,
          },
        );
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const abort = () => {
          if (child.pid === undefined) return;
          try {
            if (detached) process.kill(-child.pid, "SIGTERM");
            else child.kill("SIGTERM");
          } catch {
            // The child may already have exited.
          }
          killTimer = setTimeout(() => {
            try {
              if (detached) process.kill(-child.pid!, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {
              // The child may already have exited.
            }
          }, 5_000);
          killTimer.unref?.();
        };
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          opts.signal?.removeEventListener("abort", abort);
          if (killTimer) clearTimeout(killTimer);
          resolve(ok);
        };
        opts.signal?.addEventListener("abort", abort, { once: true });
        child.on("close", (code) => {
          finish(code === 0);
        });
        child.on("error", (error) => {
          console.error(`❌ Failed to spawn ci-fix for ${prUrl}: ${error.message}`);
          finish(false);
        });
      }),
  );
}

interface PendingFailure {
  externalId: string;
  name: string;
  conclusion: string | null;
  detailsUrl?: string;
}

type CiAggregateState = "unknown" | "empty" | "pending" | "success" | "failure";

interface CachedCiSnapshot {
  sha: string;
  state: CiAggregateState;
  failures: PendingFailure[];
}

type PollOutcome = "active" | "unchanged-green" | "removed";

interface GreenPollSchedule {
  /** Index of the delay to use after the next unchanged-green observation. */
  nextBackoffIndex: number;
  nextPollAt: number;
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
  private greenPollSchedules = new Map<string, GreenPollSchedule>();

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
        `(watching ${
          this.options.watchedChanges?.().length ??
          this.options.workerState.listOpenAgentPrs().length
        } open change request(s))`,
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
    // Reconcile every watched PR promptly after a live cadence change.
    this.greenPollSchedules.clear();
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
  }

  /** One polling cycle over all watched PRs. Skipped while busy. */
  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    if (!(this.options.enabled?.() ?? true)) {
      // Re-enabling should always perform a prompt reconciliation.
      this.greenPollSchedules.clear();
      return;
    }
    this.busy = true;

    try {
      const watchedPrs =
        this.options.watchedChanges?.() ?? this.options.workerState.listOpenAgentPrs();
      const watchedKeys = new Set(watchedPrs.map((pr) => this.prKey(pr.repo, pr.prNumber)));
      for (const key of this.greenPollSchedules.keys()) {
        if (!watchedKeys.has(key)) this.greenPollSchedules.delete(key);
      }

      for (const pr of watchedPrs) {
        const key = this.prKey(pr.repo, pr.prNumber);
        const schedule = this.greenPollSchedules.get(key);
        if (schedule && schedule.nextPollAt > this.now()) {
          continue;
        }

        try {
          const outcome = await this.pollPr(pr.repo, pr.prNumber);
          if (outcome === "unchanged-green") {
            this.scheduleGreenPoll(key, schedule?.nextBackoffIndex ?? 0);
          } else {
            // Pending, failing, newly changed, and newly observed CI stays on
            // the configured fast cadence. Closed PRs are removed separately.
            this.greenPollSchedules.delete(key);
          }
        } catch (error) {
          this.greenPollSchedules.delete(key);
          console.warn(
            `⚠️  [${this.name}] polling ${pr.repo}#${pr.prNumber} failed: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Promptly reconcile one watched change after an authenticated provider hint. */
  async reconcile(repo: string, prNumber: number): Promise<void> {
    if (this.busy || !(this.options.enabled?.() ?? true)) return;
    const watched = this.options.watchedChanges?.() ?? this.options.workerState.listOpenAgentPrs();
    if (!watched.some((change) => change.repo === repo && change.prNumber === prNumber)) return;
    this.busy = true;
    const key = this.prKey(repo, prNumber);
    try {
      const outcome = await this.pollPr(repo, prNumber);
      if (outcome === "unchanged-green") {
        this.scheduleGreenPoll(key, 0);
      } else {
        this.greenPollSchedules.delete(key);
      }
    } finally {
      this.busy = false;
    }
  }

  /** Poll a single PR; triggers at most one fix attempt per poll. */
  private async pollPr(repo: string, prNumber: number): Promise<PollOutcome> {
    const { workerState, github, verbose } = this.options;

    // 1. PR state (ETag-cached): unwatch closed/merged PRs, track head SHA.
    const prSource = `${this.namespace}:cipr:${repo}#${prNumber}`;
    const prCursor = workerState.getCursor(prSource);
    const prResult = await github.fetchPr(repo, prNumber, prCursor?.etag);
    if ((prResult as CiConditionalResult<PolledCiPr> & { gone?: boolean }).gone) {
      this.markClosed(repo, prNumber);
      return "removed";
    }
    if (!prResult.notModified) {
      if (prResult.etag) {
        workerState.setCursor(prSource, prResult.data?.head?.sha ?? "", prResult.etag);
      }
      if (prResult.data && prResult.data.state !== "open") {
        console.log(
          `👁️  [${this.name}] ${this.describe(repo, prNumber)} is ${prResult.data.state}; unwatching`,
        );
        this.markClosed(repo, prNumber);
        return "removed";
      }
    }

    const headSha = prResult.notModified ? prCursor?.cursorValue : prResult.data?.head?.sha;
    if (!headSha) {
      return "active";
    }

    // Fork PRs: Actions usually does not run in the base repository for the
    // fork head. Skip quietly instead of burning requests or commenting.
    const headRepo = prResult.data?.head?.repo?.full_name;
    if (headRepo && headRepo.toLowerCase() !== repo.toLowerCase()) {
      if (verbose) {
        console.log(
          `   [${this.name}] ${this.describe(repo, prNumber)} is a fork PR (${headRepo}); skipping`,
        );
      }
      return "active";
    }

    const pending: PendingFailure[] = [];
    let actionsState: CiAggregateState = "unknown";
    let statusState: CiAggregateState = "unknown";

    // 2. GitHub Actions workflow runs (ETag-cached): terminal failures only.
    // This API is available to fine-grained PATs with Actions: Read; unlike
    // the Checks API, it does not require a GitHub App or classic PAT.
    const actionsSource = `${this.namespace}:ciactions:${repo}#${prNumber}`;
    const actionsCursor = workerState.getCursor(actionsSource);
    const cachedActions = parseSnapshot(actionsCursor?.cursorValue);
    const actionsResult = await github.fetchWorkflowRuns(
      repo,
      headSha,
      cachedActions?.sha === headSha ? actionsCursor?.etag : undefined,
    );
    if (actionsResult.notModified && cachedActions?.sha === headSha) {
      actionsState = cachedActions.state;
      pending.push(...cachedActions.failures);
    }
    if (!actionsResult.notModified && actionsResult.data) {
      let sawActionSuccess = false;
      let sawActionPending = false;
      const actionFailures: PendingFailure[] = [];
      for (const run of actionsResult.data) {
        if (run.status !== "completed") {
          sawActionPending = true;
          continue;
        }
        if (run.conclusion === "success") {
          sawActionSuccess = true;
          continue;
        }
        if (run.conclusion !== "failure" && run.conclusion !== "timed_out") {
          continue;
        }
        actionFailures.push({
          externalId: run.externalId ?? `action:${repo}#${prNumber}:${headSha}:${run.id}`,
          name: run.name ?? `workflow-run-${run.id}`,
          conclusion: run.conclusion,
          detailsUrl: run.html_url,
        });
      }
      actionsState =
        actionFailures.length > 0
          ? "failure"
          : sawActionPending
            ? "pending"
            : actionsResult.data.length === 0
              ? "empty"
              : sawActionSuccess || actionsResult.data.every((run) => run.status === "completed")
                ? "success"
                : "unknown";
      pending.push(...actionFailures);
      workerState.setCursor(
        actionsSource,
        JSON.stringify({ sha: headSha, state: actionsState, failures: actionFailures }),
        actionsResult.etag,
      );
    }

    // 3. Combined commit status (ETag-cached): non-Actions reporters.
    const statusSource = `${this.namespace}:cistatus:${repo}#${prNumber}`;
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
    // (some workflows pass, others fail) must NOT keep refunding the budget.
    const fullyGreen =
      pending.length === 0 &&
      (actionsState === "success" || actionsState === "empty") &&
      (statusState === "success" || statusState === "empty") &&
      (actionsState === "success" || statusState === "success");
    if (fullyGreen) {
      this.resetRetryBudget(repo, prNumber, "CI passed");
    }
    const ciChanged =
      !prResult.notModified || !actionsResult.notModified || !statusResult.notModified;

    // 4. Split failures into fresh vs already-handled. Mark only after a
    // successful invocation so crashes/no-op runs remain retryable.
    const fresh: PendingFailure[] = [];
    for (const failure of pending) {
      if (!this.options.queue.hasProcessed(this.source, failure.externalId)) {
        fresh.push(failure);
      }
    }
    if (pending.length === 0) {
      return fullyGreen && !ciChanged ? "unchanged-green" : "active";
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
        `♻️  [${this.name}] ${this.describe(repo, prNumber)}: head moved past escalation point; retrying CI fixes`,
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
          `   [${this.name}] ${this.describe(repo, prNumber)}: retry budget exhausted; waiting for human`,
        );
      }
      return "active";
    }

    if (fresh.length === 0) {
      return "active";
    }

    console.log(
      `\n🤖 [${this.name}] CI failure(s) on ${this.describe(repo, prNumber)} @ ${headSha.slice(0, 7)}: ` +
        fresh.map((f) => f.name).join(", "),
    );

    // 6. Gather failure-relevant logs and run one fix attempt.
    const logs = await this.collectLogs(repo, headSha);
    const feedback: CiFailureFeedback = {
      repository: this.options.feedbackRepository?.(repo) ?? repo,
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
      let result: CiFixResult = false;
      try {
        result = await this.options.fixPr(repo, prNumber, feedbackPath, headSha);
      } catch (error) {
        console.warn(`⚠️  [${this.name}] CI fix invocation failed: ${(error as Error).message}`);
      }
      if (result === "deferred") {
        console.log(
          `⏳ [${this.name}] ${repo}#${prNumber} CI fix deferred before execution; retry budget preserved`,
        );
        return "active";
      }
      const ok = result;
      state.consecutiveFailures += 1;
      if (ok) {
        for (const failure of fresh) {
          this.options.queue.markProcessed(this.source, failure.externalId);
        }
      }
      if (!ok && state.consecutiveFailures >= this.maxAttempts && !state.escalatedSha) {
        state.escalatedSha = headSha;
        await this.escalateToHuman(repo, prNumber, pending);
      }
      workerState.setCiFixState(repo, prNumber, state);
      console.log(
        ok
          ? `✅ [${this.name}] ${this.describe(repo, prNumber)} CI fix pushed (attempt ` +
              `${state.consecutiveFailures}/${this.maxAttempts})`
          : `⚠️  [${this.name}] ${this.describe(repo, prNumber)} CI fix attempt did not complete`,
      );
    } finally {
      rmSync(feedbackDir, { recursive: true, force: true });
    }
    return "active";
  }

  /** Schedule the next observation for CI that is still terminal green. */
  private scheduleGreenPoll(key: string, backoffIndex: number): void {
    const boundedIndex = Math.min(backoffIndex, CI_GREEN_BACKOFF_SECONDS.length - 1);
    const delaySeconds = Math.max(
      this.options.intervalSeconds,
      CI_GREEN_BACKOFF_SECONDS[boundedIndex],
    );
    this.greenPollSchedules.set(key, {
      nextBackoffIndex: Math.min(boundedIndex + 1, CI_GREEN_BACKOFF_SECONDS.length - 1),
      nextPollAt: this.now() + delaySeconds * 1000,
    });
    if (this.options.verbose) {
      console.log(`   [${this.name}] ${key} remains green; next poll in ${delaySeconds}s`);
    }
  }

  private prKey(repo: string, prNumber: number): string {
    return `${repo.toLowerCase()}#${prNumber}`;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Collect an error-focused excerpt from failing GitHub Actions job logs. */
  private async collectLogs(repo: string, headSha: string): Promise<string | null> {
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

    console.warn(
      `⚠️  [${this.name}] ${this.options.feedbackRepository?.(repo) ?? repo}: could not fetch ${this.options.ciProviderLabel ?? "Actions"} logs; proceeding without them`,
    );
    return null;
  }

  /** Zero the attempt counter because CI went green. */
  private resetRetryBudget(repo: string, prNumber: number, reason: string): void {
    const state = this.options.workerState.getCiFixState(repo, prNumber);
    if (state.consecutiveFailures > 0 || state.escalatedSha) {
      console.log(
        `💚 [${this.name}] ${this.describe(repo, prNumber)}: ${reason}; resetting CI fix counter`,
      );
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
      "I have stopped retrying to avoid churn. " +
      (this.options.escalationRecoveryText ??
        "Push a new commit (or mention me) and I will take another look.");
    try {
      await this.options.github.postComment(repo, prNumber, body);
      console.log(
        `📣 [${this.name}] ${this.describe(repo, prNumber)}: posted escalation comment after ` +
          `${this.maxAttempts} failed attempt(s)`,
      );
    } catch (error) {
      console.warn(
        `⚠️  [${this.name}] could not post escalation comment on ${this.describe(repo, prNumber)}: ` +
          `${(error as Error).message}`,
      );
    }
  }

  private get maxAttempts(): number {
    return this.options.maxAttempts ?? DEFAULT_CI_FIX_MAX_ATTEMPTS;
  }

  private get namespace(): string {
    return this.options.namespace ?? "github";
  }

  private get source(): string {
    return this.namespace === "github" ? SOURCE : `${this.namespace}:ci`;
  }

  private markClosed(repo: string, prNumber: number): void {
    if (this.options.markClosed) this.options.markClosed(repo, prNumber);
    else this.options.workerState.markAgentPrClosed(repo, prNumber);
  }

  private describe(repo: string, prNumber: number): string {
    return this.options.describeChange?.(repo, prNumber) ?? `${repo}#${prNumber}`;
  }
}

/** Read `CI_FIX_MAX_ATTEMPTS` (default {@link DEFAULT_CI_FIX_MAX_ATTEMPTS}). */
function parseMaxAttemptsFromEnv(): number {
  const parsed = parseInt(process.env.CI_FIX_MAX_ATTEMPTS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CI_FIX_MAX_ATTEMPTS;
}
