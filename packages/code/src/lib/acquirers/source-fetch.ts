/**
 * Provider-neutral source-read health.
 *
 * A work source (error monitor, issue poller, CI watcher) must distinguish a
 * read that returned nothing from a read that could not be performed. Folding
 * both into an empty success makes a broken integration look like a quiet day
 * and lets a cursor advance past data that was never read.
 */

/** Outcome of one attempt to read a source. */
export type SourceFetchStatus = "ok" | "unreadable" | "rate-limited" | "auth-failed";

/** Failure classifications that must never advance a source cursor. */
export type SourceFetchFailureStatus = Exclude<SourceFetchStatus, "ok">;

/** Provider error carrying a machine-readable read-failure classification. */
export class SourceFetchError extends Error {
  readonly status: SourceFetchFailureStatus;
  /** Provider-suggested wait before retrying (for example a `Retry-After`). */
  readonly retryAfterMs?: number;

  constructor(
    status: SourceFetchFailureStatus,
    message: string,
    options: { retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "SourceFetchError";
    this.status = status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** One attempted read of a source and its outcome. */
export interface SourceFetchOutcome<TIssue> {
  status: SourceFetchStatus;
  /** Issues returned by the read; empty unless {@link status} is `ok`. */
  issues: TIssue[];
  /** Human-readable failure detail; absent on `ok`. */
  error?: string;
  /** Provider-suggested wait before retrying; absent unless rate-limited. */
  retryAfterMs?: number;
}

/** Per-source health update handed to durable storage. */
export interface SourceStatusInput {
  sourceId: string;
  provider: string;
  status: SourceFetchStatus;
  /** Epoch ms of this read attempt. */
  checkedAt: number;
  /** Failure detail; absent on `ok`. */
  message?: string;
  /** Provider-suggested wait before retrying; absent unless rate-limited. */
  retryAfterMs?: number;
}

/** Persisted per-source health with counters derived from read history. */
export interface SourceStatusRecord {
  sourceId: string;
  provider: string;
  status: SourceFetchStatus;
  /** Epoch ms of the most recent read attempt. */
  checkedAt: number;
  /** Epoch ms of the most recent successful read, if any. */
  lastSuccessAt?: number;
  /** Failed reads in a row; reset to zero by a successful read. */
  consecutiveFailures: number;
  /** Failure detail from the most recent read; absent after an `ok` read. */
  message?: string;
  /** When rate-limited, epoch ms after which a retry is allowed. */
  retryAfterAt?: number;
}

/** Narrow sink so acquirers can report source health without owning storage. */
export interface SourceStatusSink {
  recordSourceStatus(status: SourceStatusInput): void;
}
