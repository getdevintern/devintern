import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHub } from "../providers/github";
import type {
  TrackerComment,
  TrackerFixture,
  TrackerTicket,
  TrackerTicketState,
} from "../providers/tracker";
import { collectGitHubCleanupFailures, throwCleanupFailures } from "./cleanup";
import type { CleanupFailure } from "./cleanup";
import { FixtureWorkspace } from "./fixture-workspace";

/**
 * Mutually-exclusive status labels every tracker lifecycle scenario uses.
 *
 * The labels are created by the scenario itself (never inherited from the
 * environment) so a live run is deterministic; `E2E_TRACKER_STATUS_LABELS`
 * remains available to add operator-chosen labels to the exclusive set.
 */
export const TRACKER_STATUS_LABELS = {
  todo: "e2e: To Do",
  inProgress: "e2e: In Progress",
  inReview: "e2e: In Review",
} as const;

/** A non-status label that must survive every status transition. */
export const TRACKER_UNRELATED_LABEL = "e2e: keep";

/** Per-project status names written into `.devintern-code/settings.json`. */
export interface TrackerStatusSettings {
  inProgressStatus?: string;
  todoStatus?: string;
  prStatus?: string;
}

/** Default per-project status settings derived from {@link TRACKER_STATUS_LABELS}. */
export const TRACKER_STATUS_SETTINGS: Required<TrackerStatusSettings> = {
  todoStatus: TRACKER_STATUS_LABELS.todo,
  inProgressStatus: TRACKER_STATUS_LABELS.inProgress,
  prStatus: TRACKER_STATUS_LABELS.inReview,
};

export interface TrackerScenarioOptions {
  /** Ticket title; the created PR title becomes `[<key>] <title>`. */
  title?: string;
  /**
   * Seed a comment whose unique marker must reach the agent (default true).
   * Set false for scenarios that only need the description marker.
   */
  seedComment?: boolean;
  /** Tracker project status settings the CLI should apply. */
  statuses?: TrackerStatusSettings;
  /** Extra non-status labels seeded on the ticket (default: the unrelated label). */
  seedLabels?: string[];
  /** Create a decoy ticket outside the scenario selector (default true). */
  decoy?: boolean;
}

/** Env var carrying the mutually-exclusive status label set for a tracker. */
function statusLabelsVariable(trackerType: string): string | undefined {
  switch (trackerType) {
    case "github":
      return "GITHUB_STATUS_LABELS";
    case "gitlab":
      return "GITLAB_STATUS_LABELS";
    default:
      return undefined;
  }
}

/**
 * Build the tracker-scoped `.devintern-code/settings.json` body.
 *
 * The project key mirrors what `resolveProjectKey` derives for the tracker so
 * the CLI finds the configured per-project statuses.
 */
export function buildTrackerSettings(
  trackerType: string,
  projectKey: string,
  statuses: TrackerStatusSettings,
): Record<string, unknown> {
  return { [trackerType]: { projects: { [projectKey]: statuses } } };
}

/**
 * Delete seeded comments then close the owned tickets, attempting every
 * operation and tagging failures with their resource ids.
 */
export async function collectTrackerCleanupFailures(
  tracker: TrackerFixture,
  owned: { ticketKeys: Iterable<string>; commentIds: Iterable<string> },
): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  for (const commentId of owned.commentIds) {
    try {
      await tracker.deleteComment(commentId);
    } catch (error) {
      failures.push({ resource: `comment:${commentId}`, error });
    }
  }
  for (const ticketKey of owned.ticketKeys) {
    try {
      await tracker.closeTicket(ticketKey);
    } catch (error) {
      failures.push({ resource: `ticket:${ticketKey}`, error });
    }
  }
  return failures;
}

/**
 * Lifecycle for a scenario driven by a remote tracker ticket.
 *
 * The code host is always GitHub, but the tracker backend is injected, so a
 * provider task can add Jira/Linear/etc. without a tracker-by-code-host matrix.
 * The fixture provisions one fresh ticket (and optional seeded comment) in an
 * explicitly configured repository, runs the built CLI against the ticket's
 * real key, then closes/deletes only the resources it created.
 *
 * A decoy ticket outside the scenario's unique selector is created alongside
 * the expected ticket so a provider-native query can prove the selector picks
 * only the intended ticket.
 */
export class TrackerScenario extends FixtureWorkspace {
  // Markers are continuous alphanumeric tokens (no separators) so provider
  // full-text search treats each as one term and can match them reliably.
  private readonly markerToken = crypto.randomUUID().replace(/-/g, "");
  /** Unique marker embedded in the seeded ticket description; the selector. */
  readonly descriptionMarker = `E2EDESCRIPTIONMARKER${this.markerToken}`;
  /** Unique marker embedded in the seeded ticket comment. */
  readonly commentMarker = `E2ECOMMENTMARKER${this.markerToken}`;
  /** Unique marker on the decoy ticket, kept outside the selector. */
  readonly decoyMarker = `E2EDECOY${this.markerToken}`;

  ticket?: TrackerTicket;
  decoyTicket?: TrackerTicket;

  private readonly ownedCommentIds: string[] = [];

  constructor(
    readonly github: GitHub,
    readonly tracker: TrackerFixture,
    private readonly options: TrackerScenarioOptions = {},
  ) {
    super();
  }

  /** Title shared by the ticket and the resulting PR. */
  get title(): string {
    return this.options.title ?? "Expand the greeting";
  }

  /** Effective per-project statuses (defaults to the shared label names). */
  get statuses(): Required<TrackerStatusSettings> {
    return {
      todoStatus: this.options.statuses?.todoStatus ?? TRACKER_STATUS_SETTINGS.todoStatus,
      inProgressStatus:
        this.options.statuses?.inProgressStatus ?? TRACKER_STATUS_SETTINGS.inProgressStatus,
      prStatus: this.options.statuses?.prStatus ?? TRACKER_STATUS_SETTINGS.prStatus,
    };
  }

  /** Non-status labels the ticket starts with. */
  get seedLabels(): string[] {
    return this.options.seedLabels ?? [TRACKER_UNRELATED_LABEL];
  }

  async setup(token: string): Promise<void> {
    const statuses = this.statuses;
    await this.tracker.ensureLabels([...Object.values(statuses), ...this.seedLabels]);

    if (this.options.decoy !== false) {
      // Created before the expected ticket; ownership is recorded immediately.
      // The decoy deliberately omits the description marker so the selector
      // must not match it.
      this.decoyTicket = await this.tracker.createTicket({
        title: `${this.title} (decoy)`,
        body: `# Decoy\n\nThis ticket is outside the scenario selector and must stay untouched.\n\n${this.decoyMarker}\n`,
      });
    }

    const body = `# ${this.title}\n\nChange the greeting to Hello, world! and run bun test.\n\n${this.descriptionMarker}\n`;
    // First expected mutation; ownership is recorded immediately so a later
    // failure (comment, git setup) still cleans the ticket up.
    const ticket = await this.tracker.createTicket({
      title: this.title,
      body,
      labels: [...this.seedLabels, statuses.todoStatus],
    });
    this.ticket = ticket;
    this.useTaskKey(ticket.key);

    const providerEnv: Record<string, string> = {
      ...this.tracker.environment(),
      GITHUB_TOKEN: token,
      E2E_EXPECT_DESCRIPTION_MARKER: this.descriptionMarker,
    };
    const statusVariable = statusLabelsVariable(this.tracker.type);
    if (statusVariable) {
      // Keep any operator-configured labels and add the scenario's explicit set
      // so both are treated as mutually exclusive on transition.
      const configured = (providerEnv[statusVariable] ?? "")
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean);
      providerEnv[statusVariable] = [...new Set([...configured, ...Object.values(statuses)])].join(
        ",",
      );
    }
    if (this.options.seedComment !== false) {
      const commentId = await this.tracker.addComment(
        ticket.key,
        `Please keep the change minimal.\n\n${this.commentMarker}\n`,
      );
      this.ownedCommentIds.push(commentId);
      providerEnv.E2E_EXPECT_COMMENT_MARKER = this.commentMarker;
    }

    await this.prepare(`https://github.com/${this.github.repository}.git`, token, providerEnv);
    this.writeSettings();
  }

  /** Run the CLI against the actual tracker key with comments enabled. */
  async runTrackerTask(
    options: { agentMode?: "implement" | "fail" | "no-change"; implicitTarget?: boolean } = {},
  ) {
    if (!this.ticket) throw new Error("Tracker ticket has not been provisioned");
    return this.runTask({
      taskRef: this.ticket.key,
      skipComments: false,
      ...options,
    });
  }

  /** Run the CLI and fail the scenario when it exits non-zero. */
  async runTrackerCli(
    options: { agentMode?: "implement" | "fail" | "no-change"; implicitTarget?: boolean } = {},
  ) {
    const result = await this.runTrackerTask(options);
    if (result.exitCode !== 0) {
      throw new Error(`CLI exited ${result.exitCode}:\n${result.stdout}\n${result.stderr}`);
    }
    return result;
  }

  /** Key of the expected ticket, failing when setup did not provision it. */
  requireTicketKey(): string {
    if (!this.ticket) throw new Error("Tracker ticket has not been provisioned");
    return this.ticket.key;
  }

  getTicket(ticketKey: string): Promise<TrackerTicketState> {
    return this.tracker.getTicket(ticketKey);
  }

  listComments(ticketKey: string): Promise<TrackerComment[]> {
    return this.tracker.listComments(ticketKey);
  }

  /**
   * Provider-native selector query with bounded polling for eventual
   * consistency: resolves once the expected ticket appears, and fails when it
   * never does.
   *
   * Search engines may tokenize the marker differently or match fuzzily, so
   * every hit is confirmed client-side by re-reading the ticket body and
   * requiring the raw marker substring. The expected ticket is only reported
   * once its body actually contains the selector, which keeps a fuzzy index
   * match from being mistaken for a correct result.
   */
  async waitForSelectedTickets(deadlineMs = 30_000): Promise<TrackerTicket[]> {
    const expected = this.requireTicketKey();
    const deadline = Date.now() + deadlineMs;
    do {
      const hits = await this.tracker.findTickets(this.descriptionMarker);
      if (hits.some((ticket) => ticket.key === expected)) {
        const confirmed: TrackerTicket[] = [];
        for (const ticket of hits) {
          const detail = await this.tracker.getTicket(ticket.key);
          if (detail.body.includes(this.descriptionMarker)) confirmed.push(ticket);
        }
        if (confirmed.some((ticket) => ticket.key === expected)) return confirmed;
      }
      await Bun.sleep(1000);
    } while (Date.now() < deadline);
    throw new Error(`Ticket ${expected} never matched selector ${this.descriptionMarker}`);
  }

  async cleanup(): Promise<void> {
    const ticketKeys = [this.ticket?.key, this.decoyTicket?.key].filter((key): key is string =>
      Boolean(key),
    );
    const failures = await collectTrackerCleanupFailures(this.tracker, {
      ticketKeys,
      commentIds: this.ownedCommentIds,
    });
    if (this.tracker.cleanup) {
      try {
        await this.tracker.cleanup();
      } catch (error) {
        failures.push({ resource: `tracker:${this.tracker.type}`, error });
      }
    }
    failures.push(
      ...(await collectGitHubCleanupFailures(this.github, this.ownedBranches, this.base)),
    );
    this.dispose();
    throwCleanupFailures(
      `Tracker cleanup failed for ${this.id}; tickets ${ticketKeys.join(", ") || "not created"}`,
      failures,
    );
  }

  private writeSettings(): void {
    mkdirSync(join(this.cwd, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(this.cwd, ".devintern-code", "settings.json"),
      `${JSON.stringify(
        buildTrackerSettings(this.tracker.type, this.tracker.projectKey(), this.statuses),
        null,
        2,
      )}\n`,
    );
  }
}
