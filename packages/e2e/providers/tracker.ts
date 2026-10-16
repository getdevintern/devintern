/**
 * Provider contract for remote task-tracker fixtures.
 *
 * A scenario provisions one fresh ticket, runs the built CLI against its
 * actual tracker key, then closes/deletes only the resources it created. The
 * code host stays GitHub for every tracker (see README), so this contract
 * covers the tracker side only.
 */

/** A fresh remote ticket provisioned for a single scenario. */
export interface TrackerTicket {
  /** Tracker-native key used for branch naming and run-record lookups. */
  key: string;
  /** Human-readable ticket URL, when the provider exposes one. */
  url?: string;
}

/** Everything a tracker scenario needs from a tracker backend. */
export interface TrackerFixture {
  /** `TASK_TRACKER` value the CLI subprocess must use. */
  readonly type: string;
  /**
   * Explicit tracker configuration/credentials for the CLI subprocess. This is
   * merged into the isolated environment; nothing is inherited implicitly.
   */
  environment(): Record<string, string>;
  /**
   * Project/board/repository key the CLI resolves for per-project settings
   * (mirrors `resolveProjectKey` for this tracker).
   */
  projectKey(): string;
  /** Create a ticket in the pre-configured project/board/repository. */
  createTicket(input: { title: string; body: string; labels?: string[] }): Promise<TrackerTicket>;
  /** Post a seeded comment and return its provider-assigned id. */
  addComment(ticketKey: string, body: string): Promise<string>;
  /** Close/archive the scenario-owned ticket (never the containing project). */
  closeTicket(ticketKey: string): Promise<void>;
  /** Delete a seeded comment owned by the scenario. */
  deleteComment(commentId: string): Promise<void>;
}
