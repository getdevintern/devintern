import { GitHub } from "../providers/github";
import type { TrackerFixture, TrackerTicket } from "../providers/tracker";
import { collectGitHubCleanupFailures, throwCleanupFailures } from "./cleanup";
import type { CleanupFailure } from "./cleanup";
import { FixtureWorkspace } from "./fixture-workspace";

export interface TrackerScenarioOptions {
  /** Ticket title; the created PR title becomes `[<key>] <title>`. */
  title?: string;
  /**
   * Seed a comment whose unique marker must reach the agent (default true).
   * Set false for scenarios that only need the description marker.
   */
  seedComment?: boolean;
}

/**
 * Delete seeded comments then close the owned ticket, attempting every
 * operation and tagging failures with their resource ids.
 */
export async function collectTrackerCleanupFailures(
  tracker: TrackerFixture,
  owned: { ticketKey?: string; commentIds: Iterable<string> },
): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  for (const commentId of owned.commentIds) {
    try {
      await tracker.deleteComment(commentId);
    } catch (error) {
      failures.push({ resource: `comment:${commentId}`, error });
    }
  }
  if (owned.ticketKey) {
    try {
      await tracker.closeTicket(owned.ticketKey);
    } catch (error) {
      failures.push({ resource: `ticket:${owned.ticketKey}`, error });
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
 */
export class TrackerScenario extends FixtureWorkspace {
  /** Unique marker embedded in the seeded ticket description. */
  readonly descriptionMarker = `E2E_DESCRIPTION_MARKER_${crypto.randomUUID()}`;
  /** Unique marker embedded in the seeded ticket comment. */
  readonly commentMarker = `E2E_COMMENT_MARKER_${crypto.randomUUID()}`;

  ticket?: TrackerTicket;
  private readonly ownedCommentIds: string[] = [];

  constructor(
    readonly github: GitHub,
    readonly tracker: TrackerFixture,
    private readonly options: TrackerScenarioOptions = {},
  ) {
    super();
  }

  async setup(token: string): Promise<void> {
    const title = this.options.title ?? "Expand the greeting";
    const body = `# ${title}\n\nChange the greeting to Hello, world! and run bun test.\n\n${this.descriptionMarker}\n`;
    // First remote mutation; ownership is recorded immediately so a later
    // failure (comment, git setup) still cleans the ticket up.
    const ticket = await this.tracker.createTicket({ title, body });
    this.ticket = ticket;
    this.useTaskKey(ticket.key);

    const providerEnv: Record<string, string> = {
      ...this.tracker.environment(),
      GITHUB_TOKEN: token,
      E2E_EXPECT_DESCRIPTION_MARKER: this.descriptionMarker,
    };
    if (this.options.seedComment !== false) {
      const commentId = await this.tracker.addComment(
        ticket.key,
        `Please keep the change minimal.\n\n${this.commentMarker}\n`,
      );
      this.ownedCommentIds.push(commentId);
      providerEnv.E2E_EXPECT_COMMENT_MARKER = this.commentMarker;
    }

    await this.prepare(`https://github.com/${this.github.repository}.git`, token, providerEnv);
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

  async cleanup(): Promise<void> {
    const failures = await collectTrackerCleanupFailures(this.tracker, {
      ticketKey: this.ticket?.key,
      commentIds: this.ownedCommentIds,
    });
    failures.push(
      ...(await collectGitHubCleanupFailures(this.github, this.ownedBranches, this.base)),
    );
    this.dispose();
    throwCleanupFailures(
      `Tracker cleanup failed for ${this.id}; ticket ${this.ticket?.key ?? "not created"}`,
      failures,
    );
  }
}
