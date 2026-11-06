/**
 * Relay acquirer (worker Mode 2): long-polls the DevIntern control plane for
 * reference envelopes and dispatches them to the same execution paths the
 * Mode 1 polling acquirers use.
 *
 * Envelopes carry references only (repo, PR number, task key) — the worker
 * fetches real data directly from GitHub / the tracker with its own local
 * credentials, so nothing sensitive ever transits DevIntern infrastructure.
 * The only things sent upstream are the durable relay token (authentication)
 * and the cursor.
 *
 * Failure model: relay errors never crash the worker. The loop backs off
 * exponentially (5s to 5min) and recovers when the relay returns; Mode 1
 * polling keeps running as the fallback sweep, and the shared
 * `processed_events` dedupe keeps the two from double-running work.
 */

import { captureError } from "@devintern/utils";

import { parseEnvInteger } from "../config/env-integer";
import type { TaskExecutionResult } from "../acquirers/task-polling";
import type { WebhookQueue } from "../state/webhook-queue";
import type { WorkerState } from "../state/worker-state";
import { classifyWebhookError } from "../webhook/webhook-errors";
import type { Acquirer } from "../../worker";

export type RelayEventType =
  | "pr.review_submitted"
  | "pr.comment_created"
  | "task.changed"
  | "change.feedback"
  | "change.changed"
  | "ci.changed";

export interface RelayCodeHostIdentity {
  provider: "github" | "gitlab";
  instanceUrl: string;
  projectId: string;
  projectPath: string;
}

export interface RelayEnvelope {
  version?: 1 | 2;
  seq: number;
  source: string;
  /** Stable team slug for team-scoped tracker deliveries. Absent on legacy envelopes and PRs. */
  team?: string;
  eventType: RelayEventType;
  repo?: string;
  codeHost?: RelayCodeHostIdentity;
  ref: {
    pr?: number;
    commentId?: number;
    task?: string;
    change?: number;
    branch?: string;
    headSha?: string;
  };
  deliveryId: string;
  ts: string;
}

export interface RelayHandlers {
  /**
   * Review submitted on one of the agent's own PRs → address it.
   * @returns Whether the run completed; `false` means the run failed and is
   *          kept retryable (transport/5xx cannot be told apart from a
   *          deterministic failure by exit code alone, so the bounded
   *          time/attempt budget ends a permanent one). `"skipped"` means an
   *          intentional no-op (no matching workspace repo, retry gate
   *          declined, or no credentials); `"deferred"` means every harness is
   *          usage-limited and the delivery stays retryable; `"interrupted"`
   *          means a shutdown drain killed it before it settled, so the
   *          delivery stays retryable without spending an attempt.
   */
  addressPr(
    repo: string,
    prNumber: number,
  ): Promise<boolean | "deferred" | "skipped" | "interrupted">;
  /**
   * New PR conversation comment → mention/permission gates decide inside.
   * The run outcome is returned so a shutdown-drain interruption or a
   * usage-limit deferral keeps the delivery retryable, exactly like reviews.
   */
  handlePrComment(repo: string, prNumber: number, commentId: number): Promise<TaskExecutionResult>;
  /** Tracker task changed → re-evaluate the matching team/default source. */
  evaluateTask(taskKey: string, trackerSource: string, team?: string): Promise<void>;
  /** Provider-neutral change hint; implementation must re-fetch authoritative state. */
  reconcileCodeHost?(envelope: RelayEnvelope & { codeHost: RelayCodeHostIdentity }): Promise<void>;
}

export interface RelayAcquirerOptions {
  relayUrl: string;
  /** Durable `drt_…` token minted by `devintern worker connect`. */
  relayToken: string;
  workerState: WorkerState;
  queue: WebhookQueue;
  handlers: RelayHandlers;
  /** Whether a PR is in the agent's own registry (`agent_prs`). */
  isAgentPr(repo: string, prNumber: number): boolean;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  verbose?: boolean;
  /** Override the relay delivery retry window (tests/embedders). */
  deliveryRetryWindowMs?: number;
  /** Override the relay delivery attempt ceiling (tests/embedders). */
  deliveryMaxAttempts?: number;
  /**
   * Override the attempt ceiling for runs that started and failed
   * (tests/embedders). Defaults to `WORKER_RELAY_RUN_FAILURE_MAX_ATTEMPTS` or 2.
   */
  runFailureMaxAttempts?: number;
  /** Records successful long polls so fallback acquirers can yield to relay. */
  onPollSuccess?: () => void;
}

/** Dedupe source for relayed envelopes. */
const SOURCE = "relay";

/**
 * Marker: a shutdown drain stopped the run before it settled. Its failure is
 * an artifact of the drain, so the delivery is retried without spending an
 * attempt budget.
 */
class RelayInterruptedError extends Error {}

/**
 * Marker: the run never started because every harness is usage-limited.
 * Retried without spending an attempt budget, matching the polling acquirer's
 * deferral semantics.
 */
class RelayDeferredError extends Error {}

/**
 * Marker: the run itself started and the CLI reported a failure exit status.
 *
 * The exit status cannot say whether the failure was transient (a network/5xx
 * blip inside the run) or deterministic (compile error, bad repo state, prompt
 * failure), so the delivery stays retryable. Unlike a transport failure, every
 * retry costs a whole agent run, so this spends a much smaller attempt budget.
 *
 * Tagged with a symbol rather than a dedicated Error subclass to stay within
 * the file's lint-enforced class budget.
 */
const RUN_FAILED = Symbol("relayRunFailed");

function runFailedError(message: string): Error {
  return Object.assign(new Error(message), { [RUN_FAILED]: true });
}

function isRunFailedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && RUN_FAILED in error;
}

/** Client-side request timeout; the server holds long-polls up to 25s. */
const REQUEST_TIMEOUT_MS = 35_000;
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
/**
 * How long one delivery may keep failing before it is acknowledged.
 *
 * Deliberately independent of `WEBHOOK_MAX_RETRIES` (default 3): with the
 * loop's 5s-doubling backoff that budget expires in roughly 15 seconds, while
 * the common transient causes — GitHub 403 rate limits, network outages, a
 * repo fetch failing during `createFleetAddressPr` — can last minutes. A
 * time-based window keeps retrying through them without pinning the cursor
 * forever when the failure is genuinely permanent.
 *
 * Operators can shorten or extend the window with
 * `WORKER_RELAY_RETRY_WINDOW_MINUTES` (default 60).
 */
const DEFAULT_DELIVERY_RETRY_WINDOW_MS =
  parseEnvInteger("WORKER_RELAY_RETRY_WINDOW_MINUTES", 60, { min: 1, max: 7 * 24 * 60 }) * 60_000;

/**
 * Hard attempt ceiling for one delivery, independent of the window.
 *
 * The window alone let a persistently failing envelope pin the shared relay
 * cursor for an hour. With the 5s-doubling backoff (capped at 5 minutes) this
 * default gives up after roughly 10 minutes, while still riding out ordinary
 * rate limits and short outages. Operators can raise or lower it with
 * `WORKER_RELAY_MAX_ATTEMPTS` (default 8).
 */
const DEFAULT_DELIVERY_MAX_ATTEMPTS = parseEnvInteger("WORKER_RELAY_MAX_ATTEMPTS", 8, {
  min: 1,
  max: 1000,
});

/**
 * Attempt ceiling for a delivery whose run started and then failed.
 *
 * A transport failure costs one network round trip; re-running the agent after
 * a deterministic failure (compile error, bad repo state) costs a full agent
 * run. The exit status cannot distinguish the two, so the delivery stays
 * retryable but with a much tighter budget than the transport ceiling above.
 * Operators can raise or lower it with `WORKER_RELAY_RUN_FAILURE_MAX_ATTEMPTS`
 * (default 2, i.e. one retry).
 */
const DEFAULT_RUN_FAILURE_MAX_ATTEMPTS = parseEnvInteger(
  "WORKER_RELAY_RUN_FAILURE_MAX_ATTEMPTS",
  2,
  {
    min: 1,
    max: 1000,
  },
);

/**
 * Long-polls the control plane and dispatches envelopes.
 */
export class RelayAcquirer implements Acquirer {
  readonly name = "relay";
  private options: RelayAcquirerOptions;
  private running = false;
  private abort: AbortController | null = null;
  private loopDone: Promise<void> | null = null;
  private backoffMs = BACKOFF_INITIAL_MS;
  private cursorSource: string;
  private deliveryRetryWindowMs: number;
  private deliveryMaxAttempts: number;
  private runFailureMaxAttempts: number;

  constructor(options: RelayAcquirerOptions) {
    this.options = options;
    this.cursorSource = `relay:${options.relayUrl}`;
    this.deliveryRetryWindowMs = options.deliveryRetryWindowMs ?? DEFAULT_DELIVERY_RETRY_WINDOW_MS;
    this.deliveryMaxAttempts = options.deliveryMaxAttempts ?? DEFAULT_DELIVERY_MAX_ATTEMPTS;
    this.runFailureMaxAttempts = options.runFailureMaxAttempts ?? DEFAULT_RUN_FAILURE_MAX_ATTEMPTS;
  }

  /** Start the long-poll loop (runs until {@link stop}). */
  start(): void {
    this.running = true;
    console.log(`📡 Relay connected: ${this.options.relayUrl} (Mode 2)`);
    this.loopDone = this.loop();
  }

  /** Stop the loop, abort any in-flight poll, and cut short any backoff. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.wakeSleep?.();
    await this.loopDone;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const received = await this.pollOnce();
        this.backoffMs = BACKOFF_INITIAL_MS;
        if (this.options.verbose && received > 0) {
          console.log(`   [relay] processed ${received} envelope${received === 1 ? "" : "s"}`);
        }
      } catch (error) {
        if (!this.running) {
          break;
        }
        console.warn(
          `⚠️  [relay] poll failed (retrying in ${Math.round(this.backoffMs / 1000)}s): ${(error as Error).message}`,
        );
        await this.sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  }

  /** One long-poll round trip; returns the number of envelopes processed. */
  private async pollOnce(): Promise<number> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const cursor = this.options.workerState.getCursor(this.cursorSource)?.cursorValue ?? "0";

    this.abort = new AbortController();
    const timeout = setTimeout(() => this.abort?.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(
        `${this.options.relayUrl}/v1/events?cursor=${encodeURIComponent(cursor)}`,
        {
          headers: { Authorization: `Bearer ${this.options.relayToken}` },
          signal: this.abort.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
      this.abort = null;
    }

    if (!response.ok) {
      throw new Error(`relay returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as { events: RelayEnvelope[]; cursor: number };
    this.options.onPollSuccess?.();
    for (const envelope of body.events) {
      await this.dispatch(envelope);
      // Advance per envelope so a crash never re-delivers handled work
      // beyond what processed_events already guards. On empty responses the
      // local cursor is already correct (never trust the echo to move it).
      this.options.workerState.setCursor(this.cursorSource, String(envelope.seq));
    }
    return body.events.length;
  }

  private async dispatch(envelope: RelayEnvelope): Promise<void> {
    const externalId = [envelope.source, envelope.team, envelope.deliveryId]
      .filter((part): part is string => Boolean(part))
      .join(":");

    // Split dedupe into in-flight and handled. A redelivery that arrives while
    // the original is still running must not be acknowledged as done, and a
    // transient failure must not be recorded as handled so the relay redelivers.
    const claim = this.options.queue.beginDelivery(SOURCE, externalId);
    if (claim === "inFlight") {
      // Another dispatcher owns this delivery. Keep the cursor here until
      // that run settles; skipping it would acknowledge unfinished work.
      throw new Error(`Relay delivery ${externalId} is still in flight`);
    }
    if (claim === "handled") {
      if (this.options.verbose) {
        console.log(`   [relay] ${externalId} already ${claim}; skipping`);
      }
      return;
    }

    try {
      await this.runHandlers(envelope);
      // Success and intentional no-ops both count as handled.
      this.options.queue.completeDelivery(SOURCE, externalId);
      this.options.queue.clearRelayDeliveryAttempts(externalId);
    } catch (error) {
      if (error instanceof RelayInterruptedError) {
        // The shutdown drain killed the run before it settled. That is not a
        // failure of the delivery, so release the claim without advancing the
        // cursor or spending an attempt — the relay redelivers it after the
        // worker restarts.
        this.options.queue.abandonDelivery(SOURCE, externalId);
        console.warn(`⏸️  [relay] ${externalId} interrupted by worker shutdown; will retry`);
        throw error;
      }
      if (error instanceof RelayDeferredError) {
        // Every harness is usage-limited. This is an expected, non-failure
        // outcome (the polling path logs it with console.log only), so keep
        // the delivery retryable without reporting it or spending an attempt.
        this.options.queue.abandonDelivery(SOURCE, externalId);
        console.warn(`⏳ [relay] ${externalId} deferred until a harness is available (will retry)`);
        throw error;
      }
      const runFailed = isRunFailedError(error);
      captureError(error, {
        acquirer: this.name,
        eventType: envelope.eventType,
        externalId,
        repo: envelope.repo,
        prNumber: envelope.ref.pr,
        codeHostProvider: envelope.codeHost?.provider,
        codeHostProject: envelope.codeHost?.projectPath,
        stage: "dispatch",
        // Distinguishes a retry that re-runs a whole agent (started run
        // failed) from one that only re-attempts a transport operation, so
        // repeated agent runs are visible in error tracking.
        retryReason: runFailed ? "run-failed" : "transport",
      });
      if (classifyWebhookError(error) === "permanent") {
        // Terminal errors: acknowledge and record so
        // the relay stops redelivering.
        this.options.queue.completeDelivery(SOURCE, externalId);
        this.options.queue.clearRelayDeliveryAttempts(externalId);
        console.warn(
          `⚠️  [relay] ${externalId} failed permanently and was acknowledged: ${(error as Error).message}`,
        );
        return;
      }
      // 429/5xx/network/setup errors: record the failure. Release the claim and
      // rethrow so the poll loop backs off without advancing the cursor — the
      // relay then redelivers — until the time or attempt budget expires.
      const attempts = this.options.queue.beginRelayDeliveryAttempt(
        externalId,
        (error as Error).message,
        Date.now(),
        runFailed,
      );
      const firstAttemptAt = this.options.queue.getRelayDeliveryFirstAttemptAt(externalId);
      const retryElapsedMs = firstAttemptAt === null ? 0 : Date.now() - firstAttemptAt;
      const windowSpent = retryElapsedMs >= this.deliveryRetryWindowMs;
      // A failed run re-executes the whole agent, so it gets the tighter
      // started-run budget. That budget counts only started-run failures: a
      // prior transport failure must not consume it, or one transient 503
      // would leave a subsequent run failure with no retry. Transport failures
      // keep the larger delivery ceiling.
      const maxAttempts = runFailed ? this.runFailureMaxAttempts : this.deliveryMaxAttempts;
      const budgetedAttempts = runFailed
        ? this.options.queue.getRelayDeliveryRunFailureAttempts(externalId)
        : attempts;
      const attemptsSpent = budgetedAttempts >= maxAttempts;
      if (windowSpent || attemptsSpent) {
        // One permanently failing envelope must not pin the cursor (and every
        // later envelope) forever. Acknowledge it once either budget is spent.
        this.options.queue.completeDelivery(SOURCE, externalId);
        this.options.queue.clearRelayDeliveryAttempts(externalId);
        console.warn(
          `⚠️  [relay] ${externalId} failed after ` +
            (windowSpent
              ? `${Math.round(this.deliveryRetryWindowMs / 60_000)} minutes`
              : `${budgetedAttempts} attempt${budgetedAttempts === 1 ? "" : "s"}`) +
            ` and was acknowledged: ${(error as Error).message}`,
        );
        return;
      }
      this.options.queue.abandonDelivery(SOURCE, externalId);
      console.warn(
        `⚠️  [relay] transient failure for ${externalId} ` +
          `(attempt ${budgetedAttempts}/${maxAttempts}, retrying for up to ` +
          `${Math.round(this.deliveryRetryWindowMs / 60_000)} minutes): ${(error as Error).message}`,
      );
      throw error;
    }
  }

  private async runHandlers(envelope: RelayEnvelope): Promise<void> {
    const { handlers } = this.options;
    switch (envelope.eventType) {
      case "pr.review_submitted": {
        const { repo } = envelope;
        const pr = envelope.ref.pr;
        if (!repo || pr === undefined) {
          return;
        }
        if (!this.options.isAgentPr(repo, pr)) {
          // Reviews on human PRs act only via @mention comments.
          if (this.options.verbose) {
            console.log(`   [relay] ignoring review on non-agent PR ${repo}#${pr}`);
          }
          return;
        }
        console.log(`📌 [relay] review feedback on ${repo}#${pr}`);
        const ok = await handlers.addressPr(repo, pr);
        if (ok === "deferred") {
          throw new RelayDeferredError(
            `Relay review ${repo}#${pr} deferred until a harness is available`,
          );
        }
        if (ok === "interrupted") {
          // A shutdown drain killed the run; its outcome is unknown, not
          // failed. Keep the delivery retryable so it is not lost.
          throw new RelayInterruptedError(`Relay review ${repo}#${pr} was interrupted`);
        }
        if (ok === "skipped") {
          console.log(`⏭️  [relay] ${repo}#${pr} skipped; nothing to address`);
          return;
        }
        if (!ok) {
          // The process started but its subprocess failed. That failure can be
          // transient (network/5xx) or terminal, and the exit code alone does
          // not distinguish them. Keep the delivery retryable instead of
          // acknowledging it, but under the tighter started-run attempt budget
          // so a deterministic failure is not re-run many times. Callers that
          // know a run is a terminal no-op return `"skipped"` instead.
          throw runFailedError(
            `Review run for ${repo}#${pr} did not complete cleanly; keeping the delivery retryable`,
          );
        }
        console.log(`✅ [relay] ${repo}#${pr} feedback addressed`);
        return;
      }
      case "pr.comment_created": {
        await this.dispatchMention(envelope);
        return;
      }
      case "task.changed": {
        if (envelope.ref.task) {
          await handlers.evaluateTask(envelope.ref.task, envelope.source, envelope.team);
        }
        return;
      }
      case "change.feedback":
      case "change.changed":
      case "ci.changed": {
        if (
          envelope.version !== 2 ||
          !envelope.codeHost ||
          envelope.codeHost.provider !== envelope.source ||
          (!envelope.ref.change && !envelope.ref.branch && !envelope.ref.headSha)
        ) {
          return;
        }
        await handlers.reconcileCodeHost?.(
          envelope as RelayEnvelope & { codeHost: RelayCodeHostIdentity },
        );
        return;
      }
      default:
        if (this.options.verbose) {
          console.log(`   [relay] ignoring unknown event type ${envelope.eventType as string}`);
        }
    }
  }

  /**
   * Dispatch one PR-comment envelope and translate the mention run's outcome
   * into the shared retry semantics.
   */
  private async dispatchMention(envelope: RelayEnvelope): Promise<void> {
    const { repo } = envelope;
    const pr = envelope.ref.pr;
    const commentId = envelope.ref.commentId;
    if (!repo || pr === undefined || commentId === undefined) {
      return;
    }
    const outcome = await this.options.handlers.handlePrComment(repo, pr, commentId);
    if (outcome === "deferred") {
      throw new RelayDeferredError(
        `Relay mention ${repo}#${pr} deferred until a harness is available`,
      );
    }
    if (outcome === "interrupted") {
      // A shutdown drain killed the run; its outcome is unknown, so this
      // delivery must stay retryable just like an interrupted review.
      throw new RelayInterruptedError(`Relay mention ${repo}#${pr} was interrupted`);
    }
    if (outcome === "skipped") {
      console.log(`⏭️  [relay] mention on ${repo}#${pr} skipped; nothing to address`);
      return;
    }
    if (!outcome) {
      // Like a failed review run: the exit code does not say whether the
      // failure is transport-level or deterministic, so keep it retryable and
      // let the tighter started-run budget stop a permanent failure from
      // re-running the agent repeatedly.
      throw runFailedError(
        `Mention run on ${repo}#${pr} did not complete cleanly; keeping the delivery retryable`,
      );
    }
  }

  private wakeSleep: (() => void) | null = null;

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.wakeSleep = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wakeSleep = () => {
        clearTimeout(timer);
        finish();
      };
    });
  }
}
