/**
 * Process-local admission supervisor for worker agent jobs.
 *
 * The request metadata is intentionally independent from the temporary host
 * executor. A later durable scheduler can retain the Promise facade while
 * replacing the callback with executor dispatch.
 */

export type JobKind = "task" | "review" | "ci_fix" | "conflict" | "automation" | "estimation";

export type HostCheckoutClass = "task_worktree" | "shared_base" | "workspace";

export interface ScheduleRequest<T> {
  id: string;
  source: string;
  repo?: string;
  kind: JobKind;
  label?: string;
  checkoutClass: HostCheckoutClass;
  run: (signal: AbortSignal) => Promise<T>;
}

export interface SupervisorLimits {
  maxConcurrency: number;
  maxConcurrencyPerRepo: number;
}

export interface DrainOptions {
  graceMs?: number;
}

export interface TaskSupervisor {
  schedule<T>(request: ScheduleRequest<T>): Promise<T>;
  updateLimits(limits: SupervisorLimits): void;
  drain(options?: DrainOptions): Promise<void>;
}

export const DEFAULT_SUPERVISOR_DRAIN_GRACE_MS = 20_000;

/** A scheduled job was rejected before its callback began. */
export class JobNotStartedError extends Error {
  constructor(message = "The worker is draining; the queued job was not started.") {
    super(message);
    this.name = "JobNotStartedError";
  }
}

interface QueuedJob {
  request: ScheduleRequest<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface RunningJob {
  request: ScheduleRequest<unknown>;
  controller: AbortController;
  settled: Promise<void>;
}

function validateLimits(limits: SupervisorLimits): void {
  if (!Number.isInteger(limits.maxConcurrency) || limits.maxConcurrency < 1) {
    throw new Error("maxConcurrency must be a positive integer.");
  }
  if (!Number.isInteger(limits.maxConcurrencyPerRepo) || limits.maxConcurrencyPerRepo < 1) {
    throw new Error("maxConcurrencyPerRepo must be a positive integer.");
  }
  if (limits.maxConcurrencyPerRepo > limits.maxConcurrency) {
    throw new Error("maxConcurrencyPerRepo cannot exceed maxConcurrency.");
  }
}

function validateRequest(request: ScheduleRequest<unknown>): void {
  if (!request.id.trim()) throw new Error("Scheduled jobs require a non-empty id.");
  if (!request.source.trim()) throw new Error("Scheduled jobs require a non-empty source.");
  if (request.checkoutClass !== "workspace" && !request.repo?.trim()) {
    throw new Error(`${request.checkoutClass} jobs require a repository.`);
  }
}

/** Create the minimal in-memory supervisor used by the host executor. */
export function createTaskSupervisor(initialLimits: SupervisorLimits): TaskSupervisor {
  validateLimits(initialLimits);

  let limits = { ...initialLimits };
  let draining = false;
  const queued: QueuedJob[] = [];
  const running = new Map<string, RunningJob>();
  const knownIds = new Set<string>();
  const taskCounts = new Map<string, number>();
  const occupiedBaseRepos = new Set<string>();

  const canStart = (request: ScheduleRequest<unknown>): boolean => {
    if (running.size >= limits.maxConcurrency) return false;
    if (request.checkoutClass === "task_worktree") {
      return (taskCounts.get(request.repo!) ?? 0) < limits.maxConcurrencyPerRepo;
    }
    if (request.checkoutClass === "shared_base") {
      return !occupiedBaseRepos.has(request.repo!);
    }
    return true;
  };

  const acquireResources = (request: ScheduleRequest<unknown>): void => {
    if (request.checkoutClass === "task_worktree") {
      taskCounts.set(request.repo!, (taskCounts.get(request.repo!) ?? 0) + 1);
    } else if (request.checkoutClass === "shared_base") {
      occupiedBaseRepos.add(request.repo!);
    }
  };

  const releaseResources = (request: ScheduleRequest<unknown>): void => {
    if (request.checkoutClass === "task_worktree") {
      const next = (taskCounts.get(request.repo!) ?? 1) - 1;
      if (next === 0) taskCounts.delete(request.repo!);
      else taskCounts.set(request.repo!, next);
    } else if (request.checkoutClass === "shared_base") {
      occupiedBaseRepos.delete(request.repo!);
    }
  };

  let pumping = false;
  const pump = (): void => {
    if (pumping || draining) return;
    pumping = true;
    try {
      // Scan for the first admissible job each time. A saturated repository
      // must not block unrelated work queued behind it.
      for (;;) {
        const index = queued.findIndex((job) => canStart(job.request));
        if (index < 0) return;
        const [job] = queued.splice(index, 1);
        if (!job) return;

        const { request } = job;
        const controller = new AbortController();
        acquireResources(request);
        let settleRunning!: () => void;
        const settled = new Promise<void>((resolve) => {
          settleRunning = resolve;
        });
        running.set(request.id, { request, controller, settled });

        let runPromise: Promise<unknown>;
        try {
          // Invoke immediately after recording the running state. This closes
          // the shutdown race where a controller could be aborted before the
          // callback had installed its signal listener.
          runPromise = Promise.resolve(request.run(controller.signal));
        } catch (error) {
          runPromise = Promise.reject(error);
        }
        const release = () => {
          running.delete(request.id);
          knownIds.delete(request.id);
          releaseResources(request);
          settleRunning();
          pump();
        };
        const settleJob = async (): Promise<void> => {
          try {
            const result = await runPromise;
            release();
            job.resolve(result);
          } catch (error) {
            release();
            job.reject(error);
          }
        };
        void settleJob();
      }
    } finally {
      pumping = false;
    }
  };

  return {
    schedule<T>(request: ScheduleRequest<T>): Promise<T> {
      try {
        validateRequest(request as ScheduleRequest<unknown>);
      } catch (error) {
        return Promise.reject(error);
      }
      if (draining) return Promise.reject(new JobNotStartedError());
      if (knownIds.has(request.id)) {
        return Promise.reject(new Error(`A job with id "${request.id}" is already scheduled.`));
      }
      knownIds.add(request.id);
      const promise = new Promise<T>((resolve, reject) => {
        queued.push({
          request: request as ScheduleRequest<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });
      pump();
      return promise;
    },

    updateLimits(next: SupervisorLimits): void {
      validateLimits(next);
      limits = { ...next };
      pump();
    },

    async drain(options: DrainOptions = {}): Promise<void> {
      if (!draining) {
        draining = true;
        const error = new JobNotStartedError();
        for (const job of queued.splice(0)) {
          knownIds.delete(job.request.id);
          job.reject(error);
        }
      }

      const waitForRunning = (): Promise<void> =>
        Promise.all([...running.values()].map((job) => job.settled)).then(() => undefined);
      if (running.size === 0) return;

      const graceMs = options.graceMs ?? DEFAULT_SUPERVISOR_DRAIN_GRACE_MS;
      if (graceMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const graceExpired = new Promise<"expired">((resolve) => {
          timer = setTimeout(() => resolve("expired"), graceMs);
        });
        const result = await Promise.race([
          waitForRunning().then(() => "settled" as const),
          graceExpired,
        ]);
        if (timer) clearTimeout(timer);
        if (result === "settled") return;
      }

      for (const job of running.values()) job.controller.abort();
      await waitForRunning();
    },
  };
}
