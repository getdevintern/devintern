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

import type { WebhookQueue } from "./webhook-queue";
import type { WorkerState } from "./worker-state";
import type { Acquirer } from "../worker";

export type RelayEventType = "pr.review_submitted" | "pr.comment_created" | "task.changed";

export interface RelayEnvelope {
  seq: number;
  source: string;
  eventType: RelayEventType;
  repo?: string;
  ref: { pr?: number; commentId?: number; task?: string };
  deliveryId: string;
  ts: string;
}

export interface RelayHandlers {
  /**
   * Review submitted on one of the agent's own PRs → address it.
   * @returns Whether the run completed; `false` means it failed or matched
   *          no workspace repo (never silently swallowed by the caller).
   */
  addressPr(repo: string, prNumber: number): Promise<boolean>;
  /** New PR conversation comment → mention/permission gates decide inside. */
  handlePrComment(repo: string, prNumber: number, commentId: number): Promise<void>;
  /** Tracker task changed → re-evaluate the user's query and run if ready. */
  evaluateTask(taskKey: string): Promise<void>;
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
  /** Records successful long polls so fallback acquirers can yield to relay. */
  onPollSuccess?: () => void;
}

/** Dedupe source for relayed envelopes. */
const SOURCE = "relay";

/** Client-side request timeout; the server holds long-polls up to 25s. */
const REQUEST_TIMEOUT_MS = 35_000;
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

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

  constructor(options: RelayAcquirerOptions) {
    this.options = options;
    this.cursorSource = `relay:${options.relayUrl}`;
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
    const externalId = `${envelope.source}:${envelope.deliveryId}`;
    if (this.options.queue.hasProcessed(SOURCE, externalId)) {
      return;
    }
    // Mark before executing (same convention as the polling acquirers): a
    // failing run must not re-trigger on every subsequent poll.
    this.options.queue.markProcessed(SOURCE, externalId);

    const { handlers } = this.options;
    try {
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
          console.log(
            ok
              ? `✅ [relay] ${repo}#${pr} feedback addressed`
              : `⚠️  [relay] ${repo}#${pr} feedback run did not complete cleanly`,
          );
          return;
        }
        case "pr.comment_created": {
          const { repo } = envelope;
          const pr = envelope.ref.pr;
          const commentId = envelope.ref.commentId;
          if (!repo || pr === undefined || commentId === undefined) {
            return;
          }
          await handlers.handlePrComment(repo, pr, commentId);
          return;
        }
        case "task.changed": {
          if (envelope.ref.task) {
            await handlers.evaluateTask(envelope.ref.task);
          }
          return;
        }
        default:
          if (this.options.verbose) {
            console.log(`   [relay] ignoring unknown event type ${envelope.eventType as string}`);
          }
      }
    } catch (error) {
      captureError(error, {
        acquirer: this.name,
        eventType: envelope.eventType,
        externalId,
        repo: envelope.repo,
        prNumber: envelope.ref.pr,
        stage: "dispatch",
      });
      console.warn(
        `⚠️  [relay] handler failed for ${envelope.eventType} (${externalId}): ${(error as Error).message}`,
      );
    }
  }

  private wakeSleep: (() => void) | null = null;

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeSleep = null;
        resolve();
      }, ms);
      this.wakeSleep = () => {
        clearTimeout(timer);
        this.wakeSleep = null;
        resolve();
      };
    });
  }
}
