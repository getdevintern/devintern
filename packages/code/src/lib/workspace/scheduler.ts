/**
 * Bounded workspace execution scheduler.
 *
 * Fleet mode funnels every execution — polling tasks, relay task events,
 * PR review runs, and mention-triggered runs — through one scheduler with:
 *
 * - A global concurrency limit (`maxConcurrent`): at most that many runs are
 *   in flight across the whole workspace. Serial mode is the degenerate
 *   case `maxConcurrent === 1`, which reproduces the historical
 *   one-task-at-a-time behavior in exact submission order.
 * - Keyed per-repo lanes: work for the same repo key executes FIFO and never
 *   concurrently, no matter which acquirer submitted it. Different repos'
 *   lanes proceed independently, so a slow or contended repo cannot starve
 *   the rest, and excess work queues instead of being dropped or overlapping.
 *
 * Dispatch follows global submission order: the oldest runnable item whose
 * repo lane is free gets the next slot. Same-repo items therefore stay FIFO,
 * while items stuck behind a busy lane never block unrelated repos.
 *
 * Lock contention (the cross-process `<workspace>/locks/<repo>.run.lock`
 * held by another process) is signalled by throwing {@link RepoBusyError}
 * from the work: the item returns to the FRONT of its lane and retries after
 * {@link WorkspaceSchedulerOptions.retryDelayMs} without consuming a global
 * slot and without resolving the submission — callers keep their dedupe
 * semantics and nothing is treated as a completed attempt.
 *
 * Shutdown policy (see {@link WorkspaceScheduler.drain}): stop admitting new
 * work, cancel queued/deferred items (their `onCancel` hooks run first, so
 * task dedupe marks can be rolled back and the tasks re-acquired on the next
 * start), and await in-flight runs so per-repo locks are always released.
 */

/**
 * Thrown by scheduled work when the repo's cross-process run lock is held
 * elsewhere. The scheduler defers and retries instead of failing the work.
 */
export class RepoBusyError extends Error {
  readonly repo: string;

  constructor(repo: string, message?: string) {
    super(message ?? `repo "${repo}" is busy`);
    this.name = "RepoBusyError";
    this.repo = repo;
  }
}

/** Rejected for submissions once shutdown has begun (or cancelled them). */
export class SchedulerStoppedError extends Error {
  constructor() {
    super("workspace scheduler is shutting down; new work is not accepted");
    this.name = "SchedulerStoppedError";
  }
}

/** Lifecycle of one repository from the scheduler's point of view. */
export type RepoRunStatus = "idle" | "queued" | "running";

export interface RepoActivity {
  repo: string;
  status: RepoRunStatus;
  /** Label of the running (or head queued) item — task key / PR ref. */
  label?: string;
  /** Epoch ms when the current run started (running items only). */
  startedAt?: number;
  /** Items waiting in this repo's lane. */
  queued: number;
}

export interface SchedulerStatus {
  /** Runs currently in flight across all lanes. */
  active: number;
  /** Global concurrency limit. */
  max: number;
  /** Total items waiting across all lanes. */
  queued: number;
  repos: RepoActivity[];
}

export interface ScheduleOptions {
  /** Human-readable description shown in status output (task key, PR ref). */
  label?: string;
  /**
   * Rollback for accepted-but-never-started work cancelled by
   * {@link WorkspaceScheduler.drain} (e.g. remove the task's dedupe mark so
   * the next worker start re-acquires it).
   */
  onCancel?: () => void;
}

export interface WorkspaceSchedulerOptions {
  maxConcurrent: number;
  /** Delay before a lock-contended item retries its lane (ms). */
  retryDelayMs?: number;
}

interface QueueItem {
  repo: string;
  label?: string;
  work: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  onCancel?: () => void;
  /** Epoch ms before which a lock-deferred item must not restart. */
  readyAt?: number;
}

interface Lane {
  /** FIFO of this repo's waiting items (head first). */
  queue: QueueItem[];
  /** The item currently holding the lane and running. */
  active: { item: QueueItem; startedAt: number } | null;
}

export interface DrainSummary {
  /** In-flight runs that were awaited to completion. */
  drained: number;
  /** Queued/deferred items cancelled via their `onCancel` hook. */
  cancelled: number;
}

export class WorkspaceScheduler {
  private readonly maxConcurrent: number;
  private readonly retryDelayMs: number;
  private readonly lanes = new Map<string, Lane>();
  /** Global submission-order mirror of every queued item (for fair dispatch). */
  private order: QueueItem[] = [];
  private runningCount = 0;
  private stopped = false;
  private drainPromise: Promise<DrainSummary> | null = null;
  private drainWaiters: Array<{ inflight: number; resolve: () => void }> = [];
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * Invoked after every scheduling transition (dispatch, completion,
   * deferral, cancellation). Never throws into the scheduler.
   */
  onChange: (() => void) | null = null;

  constructor(options: WorkspaceSchedulerOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error("WorkspaceScheduler needs a positive integer maxConcurrent.");
    }
    this.maxConcurrent = options.maxConcurrent;
    this.retryDelayMs = options.retryDelayMs ?? 10_000;
  }

  /**
   * Submit one unit of work under a repo's lane.
   *
   * Resolves with the work's result once it completes (after any
   * contention-driven retries). Rejects only on real work failure or
   * shutdown cancellation.
   *
   * @param repo - Repo lane key (the workspace repo's name)
   * @param options - Label and cancellation hook
   * @param work - The execution itself; throws {@link RepoBusyError} to defer
   */
  schedule<T>(repo: string, options: ScheduleOptions, work: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new SchedulerStoppedError());
    }

    return new Promise<T>((resolve, reject) => {
      const lane = this.lane(repo);
      const item: QueueItem = {
        repo,
        label: options.label,
        work: work as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        onCancel: options.onCancel,
      };
      lane.queue.push(item);
      this.order.push(item);
      this.emit();
      this.pump();
    });
  }

  /**
   * Current activity snapshot. Configured repos are always listed (idle when
   * untouched); ad-hoc lanes appear after them in submission order.
   */
  status(configuredRepos: string[] = []): SchedulerStatus {
    const seen = new Set<string>();
    const repos: RepoActivity[] = [];

    const describe = (repo: string): RepoActivity => {
      seen.add(repo);
      const lane = this.lanes.get(repo);
      if (!lane || (lane.queue.length === 0 && !lane.active)) {
        return { repo, status: "idle", queued: 0 };
      }
      if (lane.active) {
        return {
          repo,
          status: "running",
          label: lane.active.item.label,
          startedAt: lane.active.startedAt,
          queued: lane.queue.length,
        };
      }
      const head = lane.queue[0];
      return { repo, status: "queued", label: head?.label, queued: lane.queue.length };
    };

    for (const repo of configuredRepos) {
      repos.push(describe(repo));
    }
    for (const repo of this.lanes.keys()) {
      if (!seen.has(repo)) {
        repos.push(describe(repo));
      }
    }

    return {
      active: this.runningCount,
      max: this.maxConcurrent,
      queued: this.order.length,
      repos,
    };
  }

  /** Global concurrency limit. */
  get capacity(): number {
    return this.maxConcurrent;
  }

  /** Whether the scheduler has stopped accepting work. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Graceful shutdown: stop admitting work, cancel everything that never
   * started (each cancelled item's `onCancel` rollback runs before its
   * submission rejects), and await in-flight runs so locks and subprocesses
   * settle before the caller exits.
   */
  drain(): Promise<DrainSummary> {
    if (this.drainPromise) {
      return this.drainPromise;
    }
    this.stopped = true;

    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();

    const pending = this.order;
    this.order = [];
    for (const lane of this.lanes.values()) {
      lane.queue = [];
    }

    let cancelled = 0;
    for (const item of pending) {
      cancelled++;
      try {
        item.onCancel?.();
      } catch (error) {
        console.warn(`⚠️  [fleet] cancellation cleanup failed: ${(error as Error).message}`);
      }
      item.reject(new SchedulerStoppedError());
    }
    this.emit();

    const inflight = this.runningCount;
    if (inflight === 0) {
      this.drainPromise = Promise.resolve({ drained: 0, cancelled });
      return this.drainPromise;
    }

    this.drainPromise = new Promise<DrainSummary>((resolve) => {
      this.drainWaiters.push({
        inflight,
        resolve: () => resolve({ drained: inflight, cancelled }),
      });
      this.notifyDrainWaiters();
    });
    return this.drainPromise;
  }

  /** Resolve drain waiters once every in-flight run has settled. */
  private notifyDrainWaiters(): void {
    if (this.runningCount > 0) {
      return;
    }
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  /** Fire the change hook without ever failing a scheduling transition. */
  private emit(): void {
    const handler = this.onChange;
    if (!handler) {
      return;
    }
    try {
      handler();
    } catch {
      // Status persistence is observability only; never break execution.
    }
  }

  private lane(repo: string): Lane {
    let lane = this.lanes.get(repo);
    if (!lane) {
      lane = { queue: [], active: null };
      this.lanes.set(repo, lane);
    }
    return lane;
  }

  /**
   * Start the oldest runnable items, within the global limit. Items whose
   * lane is busy or which are waiting out a contention backoff are skipped
   * in-place; they neither block newer unrelated work nor lose their
   * same-repo FIFO position (a deferred head also blocks its own lane's
   * followers until it becomes ready again).
   */
  private pump(): void {
    if (this.stopped) {
      return;
    }
    let skippedDeferred = false;
    const blockedRepos = new Set<string>();
    let scanIndex = 0;
    while (this.runningCount < this.maxConcurrent && scanIndex < this.order.length) {
      const item = this.order[scanIndex];
      if ((item.readyAt ?? 0) > Date.now()) {
        skippedDeferred = true;
        blockedRepos.add(item.repo);
        scanIndex++;
        continue;
      }
      // Preserve per-repo FIFO behind a not-yet-ready head.
      if (blockedRepos.has(item.repo)) {
        scanIndex++;
        continue;
      }
      const lane = this.lanes.get(item.repo)!;
      if (lane.active) {
        scanIndex++;
        continue;
      }
      this.order.splice(scanIndex, 1);
      lane.queue.shift();
      lane.active = { item, startedAt: Date.now() };
      this.runningCount++;
      this.emit();
      void this.runItem(lane, item);
    }
    if (skippedDeferred && this.runningCount < this.maxConcurrent) {
      // Something is waiting out its contention backoff: nudge the pump when
      // the earliest retry becomes due (harmless if everything finished).
      this.scheduleRetryNudge();
    }
  }

  private scheduleRetryNudge(): void {
    const now = Date.now();
    let earliest = Infinity;
    for (const item of this.order) {
      if (item.readyAt && item.readyAt > now) {
        earliest = Math.min(earliest, item.readyAt);
      }
    }
    if (earliest === Infinity) {
      return;
    }
    const timer = setTimeout(
      () => {
        this.retryTimers.delete(timer);
        this.pump();
      },
      Math.max(0, earliest - now),
    );
    this.retryTimers.add(timer);
  }

  private async runItem(lane: Lane, item: QueueItem): Promise<void> {
    try {
      const result = await item.work();
      lane.active = null;
      this.runningCount--;
      item.resolve(result);
    } catch (error) {
      if (error instanceof RepoBusyError) {
        // Defer: keep FIFO position at the lane head, free the global slot.
        lane.active = null;
        this.runningCount--;
        item.readyAt = Date.now() + this.retryDelayMs;
        console.warn(
          `⚠️  [fleet] ${item.label ?? "work"} deferred: repo run lock held by another process; ` +
            `retrying in ${Math.round(this.retryDelayMs / 1000)}s`,
        );
        lane.queue.unshift(item);
        this.order.unshift(item);
        this.emit();
        this.notifyDrainWaiters();
        this.scheduleRetryNudge();
        return;
      }
      lane.active = null;
      this.runningCount--;
      item.reject(error);
      this.emit();
      this.notifyDrainWaiters();
      return;
    }
    this.emit();
    this.notifyDrainWaiters();
    this.pump();
  }
}
