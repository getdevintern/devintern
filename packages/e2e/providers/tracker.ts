/**
 * Provider contract for remote task-tracker fixtures.
 *
 * A scenario provisions one fresh ticket, runs the built CLI against its
 * actual tracker key, then closes/deletes only the resources it created. The
 * code host stays GitHub for every tracker (see README), so this contract
 * covers the tracker side only.
 *
 * Read-back methods (`getTicket`, `listComments`, `findTickets`) exist so a
 * single shared lifecycle can assert tracker state through the provider
 * instead of scraping CLI output, and so a provider-native selector can be
 * exercised against the fixtures.
 */

/** A fresh remote ticket provisioned for a single scenario. */
export interface TrackerTicket {
  /** Tracker-native key used for branch naming and run-record lookups. */
  key: string;
  /** Human-readable ticket URL, when the provider exposes one. */
  url?: string;
}

/** Current provider state of a scenario-owned ticket. */
export interface TrackerTicketState {
  /** `open`/`opened` for an active ticket, `closed` once resolved. */
  state: string;
  /** Plain label names (provider order preserved). */
  labels: string[];
  /** Description/body text as stored by the tracker. */
  body: string;
}

/** One comment/note on a scenario-owned ticket. */
export interface TrackerComment {
  /** Provider-assigned id. */
  id: string;
  /** Comment body (markdown). */
  body: string;
}

/** Everything a tracker scenario needs from a tracker backend. */
export interface TrackerFixture {
  /** `TASK_TRACKER` value the CLI subprocess must use. */
  readonly type: string;
  /**
   * Provider-native state value for an active (unresolved) ticket. GitHub
   * Issues report `open`; GitLab Issues report `opened`. The shared lifecycle
   * asserts read-back state against this value so provider semantics stay in
   * the fixture instead of leaking into the assertion body.
   */
  readonly openState: string;
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
  /**
   * Ensure every named label exists on the tracker before the ticket is
   * created. Idempotent: an existing label is left untouched. Labels are
   * shared project configuration, so they are never deleted by cleanup.
   */
  ensureLabels(labels: string[]): Promise<void>;
  /** Create a ticket in the pre-configured project/board/repository. */
  createTicket(input: { title: string; body: string; labels?: string[] }): Promise<TrackerTicket>;
  /** Post a seeded comment and return a provider handle usable by {@link deleteComment}. */
  addComment(ticketKey: string, body: string): Promise<string>;
  /** Close/archive the scenario-owned ticket (never the containing project). */
  closeTicket(ticketKey: string): Promise<void>;
  /** Delete a seeded comment owned by the scenario. */
  deleteComment(commentId: string): Promise<void>;
  /** Read the current state/labels/body of a scenario-owned ticket. */
  getTicket(ticketKey: string): Promise<TrackerTicketState>;
  /** List all comments on a scenario-owned ticket (oldest first). */
  listComments(ticketKey: string): Promise<TrackerComment[]>;
  /**
   * Provider-native query scoped to the fixture: search open tickets for
   * `query`. Used to prove the scenario's unique marker selector picks only
   * the expected ticket and leaves a decoy outside the selector untouched.
   * Provider search indexes are eventually consistent, so callers poll.
   */
  findTickets(query: string): Promise<TrackerTicket[]>;
  /**
   * Release provider resources owned by the fixture itself (for example a
   * dedicated project created for one scenario). Optional: most fixtures only
   * own tickets and comments.
   */
  cleanup?(): Promise<void>;
}
