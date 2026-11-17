/** Provider-neutral observations. Stream keys are durable cursor suffixes. */
export interface CiConditionalResult<T> {
  data: T | null;
  etag?: string;
  notModified: boolean;
  gone?: boolean;
}
export interface CiChange {
  /**
   * Remote PR state. Optional and untyped on purpose: providers can omit it
   * or report a value this worker does not recognise, and callers must treat
   * that as "unknown", never as "not open".
   */
  state?: unknown;
  headSha?: string;
  headRepository?: string;
}
export interface CiFailure {
  externalId: string;
  name: string;
  conclusion: string | null;
  detailsUrl?: string;
}
export type CiAggregateState = "unknown" | "empty" | "pending" | "success" | "failure";
export interface CiObservation {
  state: CiAggregateState;
  failures: CiFailure[];
}
export interface CiProvider {
  fetchChange(repo: string, number: number, etag?: string): Promise<CiConditionalResult<CiChange>>;
  streams: Array<{
    key: string;
    fetch(
      repo: string,
      number: number,
      sha: string,
      etag?: string,
    ): Promise<CiConditionalResult<CiObservation>>;
  }>;
  fetchFailingJobLogs(repo: string, sha: string): Promise<string | null>;
  postComment(repo: string, number: number, body: string): Promise<void>;
}
