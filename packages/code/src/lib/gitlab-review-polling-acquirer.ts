/** Poll only DevIntern-registered GitLab MRs for actionable discussions. */

import { captureError } from "@devintern/utils";
import type { Acquirer } from "../worker";
import type { TaskExecutionResult } from "./task-polling-acquirer";
import type { AutomaticResolveResult } from "./review-polling-acquirer";
import type { AgentPr, WorkerState } from "./worker-state";
import type { WebhookQueue } from "./webhook-queue";
import type { GitLabPollingSnapshot } from "./gitlab-reviews";

export interface GitLabPollingClient {
  getPollingSnapshot(project: string | number, iid: number): Promise<GitLabPollingSnapshot>;
  getMemberAccessLevel(project: string | number, userId: number): Promise<number | null>;
}

export interface GitLabReviewPollingOptions {
  intervalSeconds: number;
  workerState: Pick<WorkerState, "listOpenAgentChangeRequests" | "markAgentChangeRequestClosed">;
  queue: Pick<WebhookQueue, "hasProcessed" | "markProcessed">;
  clientFor: (mr: AgentPr) => GitLabPollingClient | null;
  addressMr: (mr: AgentPr) => Promise<TaskExecutionResult>;
  resolveMr?: (
    mr: AgentPr,
    expected: { headSha: string; baseSha?: string },
  ) => Promise<AutomaticResolveResult>;
  shouldResolve?: () => boolean;
  allowed?: (mr: AgentPr) => boolean;
  reviewerAllowlist?: Iterable<string>;
  now?: () => number;
}

const SOURCE = "gitlab:registered-mr-feedback";
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

interface RetryState {
  attempts: number;
  nextAt: number;
}

/** Registered-MR lifecycle and feedback poller; no project-wide discovery. */
export class GitLabReviewPollingAcquirer implements Acquirer {
  readonly name = "poll:gitlab-reviews";
  private options: GitLabReviewPollingOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private retries = new Map<string, RetryState>();
  private allowlist: Set<string>;

  constructor(options: GitLabReviewPollingOptions) {
    this.options = options;
    this.allowlist = new Set(
      [...(options.reviewerAllowlist ?? [])].map((username) => username.trim().toLowerCase()),
    );
  }

  async start(): Promise<void> {
    if (this.timer) return;
    const watched = this.gitLabMrs();
    console.log(
      `🔎 Polling reviews on ${watched.length} registered GitLab MR(s) every ${this.options.intervalSeconds}s`,
    );
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  updateInterval(intervalSeconds: number): void {
    this.options.intervalSeconds = intervalSeconds;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), intervalSeconds * 1000);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const mr of this.gitLabMrs()) {
        await this.pollMr(mr);
      }
    } finally {
      this.busy = false;
    }
  }

  /** Promptly reconcile one registered MR after an authenticated relay hint. */
  async reconcile(mr: AgentPr): Promise<void> {
    if (this.busy || !this.gitLabMrs().some((candidate) => this.key(candidate) === this.key(mr))) {
      return;
    }
    this.busy = true;
    try {
      await this.pollMr(mr);
    } finally {
      this.busy = false;
    }
  }

  private gitLabMrs(): AgentPr[] {
    return this.options.workerState
      .listOpenAgentChangeRequests()
      .filter((mr) => mr.provider === "gitlab" && (this.options.allowed?.(mr) ?? true));
  }

  private async pollMr(mr: AgentPr): Promise<void> {
    const key = this.key(mr);
    const retry = this.retries.get(key);
    const now = (this.options.now ?? Date.now)();
    if (retry && now < retry.nextAt) return;

    const client = this.options.clientFor(mr);
    if (!client) return;
    let snapshot: GitLabPollingSnapshot;
    try {
      snapshot = await client.getPollingSnapshot(mr.projectId ?? mr.projectPath, mr.changeNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/GitLab API error \((403|404)\)/.test(message)) {
        this.options.workerState.markAgentChangeRequestClosed(this.identity(mr));
        console.log(
          `🧹 [${this.name}] ${mr.projectPath}!${mr.changeNumber} is inaccessible; unwatching`,
        );
        return;
      }
      this.recordFailure(key, now);
      captureError(error, {
        acquirer: this.name,
        provider: "gitlab",
        repo: mr.projectPath,
        prNumber: mr.changeNumber,
        stage: "poll-mr",
      });
      console.warn(
        `⚠️  [${this.name}] polling ${mr.projectPath}!${mr.changeNumber} failed: ${message}`,
      );
      return;
    }

    if (snapshot.state !== "opened") {
      this.options.workerState.markAgentChangeRequestClosed(this.identity(mr));
      this.retries.delete(key);
      console.log(
        `🧹 [${this.name}] ${mr.projectPath}!${mr.changeNumber} is ${snapshot.state}; unwatching`,
      );
      return;
    }

    if (
      this.options.resolveMr &&
      (this.options.shouldResolve?.() ?? true) &&
      (snapshot.mergeability === "conflicts" || snapshot.mergeability === "behind")
    ) {
      const syncRetryKey = `sync:${key}`;
      const syncRetry = this.retries.get(syncRetryKey);
      if (syncRetry && now < syncRetry.nextAt) return;
      const syncKey = `sync:${key}:${snapshot.baseSha ?? "unknown"}:${snapshot.headSha}`;
      if (!this.options.queue.hasProcessed(SOURCE, syncKey)) {
        const outcome = await this.options.resolveMr(mr, {
          headSha: snapshot.headSha,
          baseSha: snapshot.baseSha,
        });
        if (outcome.outcome === "failed" || outcome.outcome === "deferred") {
          this.recordFailure(syncRetryKey, now);
        } else {
          this.options.queue.markProcessed(SOURCE, syncKey);
          this.retries.delete(syncRetryKey);
        }
        // Re-fetch provider state on the next tick before considering feedback.
        return;
      }
    }

    const candidates = [] as GitLabPollingSnapshot["feedback"];
    for (const feedback of snapshot.feedback) {
      if (new Date(feedback.createdAt).getTime() < mr.createdAt) continue;
      if (this.allowlist.size > 0 && !this.allowlist.has(feedback.author.username.toLowerCase())) {
        continue;
      }
      if (this.options.queue.hasProcessed(SOURCE, this.eventId(mr, feedback.noteId))) continue;
      const assigned = snapshot.assignedReviewerIds.includes(feedback.author.id);
      const accessLevel = assigned
        ? 30
        : await client.getMemberAccessLevel(mr.projectId ?? mr.projectPath, feedback.author.id);
      if (accessLevel === null || accessLevel < 30) continue;
      candidates.push(feedback);
    }
    if (candidates.length === 0) {
      this.retries.delete(key);
      return;
    }

    console.log(`\n📌 [${this.name}] new review feedback on ${mr.projectPath}!${mr.changeNumber}`);
    const outcome = await this.options.addressMr(mr);
    if (outcome === true) {
      for (const feedback of candidates) {
        this.options.queue.markProcessed(SOURCE, this.eventId(mr, feedback.noteId));
      }
      this.retries.delete(key);
      console.log(`✅ [${this.name}] ${mr.projectPath}!${mr.changeNumber} feedback addressed`);
      return;
    }
    this.recordFailure(key, now);
    console.log(
      outcome === "deferred"
        ? `⏳ [${this.name}] ${mr.projectPath}!${mr.changeNumber} deferred; retry scheduled`
        : `⚠️  [${this.name}] ${mr.projectPath}!${mr.changeNumber} feedback run failed; retry scheduled`,
    );
  }

  private recordFailure(key: string, now: number): void {
    const attempts = (this.retries.get(key)?.attempts ?? 0) + 1;
    this.retries.set(key, {
      attempts,
      nextAt: now + Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS),
    });
  }

  private key(mr: AgentPr): string {
    return `${mr.instanceUrl}:${mr.projectId ?? mr.projectPath}!${mr.changeNumber}`;
  }

  private eventId(mr: AgentPr, noteId: number): string {
    return `${this.key(mr)}:note:${noteId}`;
  }

  private identity(mr: AgentPr) {
    return {
      provider: mr.provider,
      instanceUrl: mr.instanceUrl,
      projectId: mr.projectId,
      projectPath: mr.projectPath,
      number: mr.changeNumber,
      webUrl: mr.webUrl,
    };
  }
}
