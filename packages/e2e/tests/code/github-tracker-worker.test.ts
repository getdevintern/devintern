/**
 * Live GitHub Issues polling by the workspace worker daemon (opt-in:
 * `test:e2e:tracker`).
 *
 * The one-shot tracker suite (`github-tracker.test.ts`) proves the CLI can
 * implement an issue by key or `--query`. This file proves the unattended
 * path: a long-lived `devintern worker` with `[defaults].tracker = "github"`
 * finds a labelled issue through its own poll, opens the PR, moves the status
 * labels, posts the summary comment, and does not pick the issue up again.
 *
 * Every issue carries a unique body marker and the query requires it, so
 * parallel runs against the shared tracker repository never see each other's
 * issues. The trigger label is shared repository configuration; like the
 * status labels it is created when missing and never deleted.
 */

import { describe, expect, test } from "bun:test";
import { GitHubWorkerFixture, redact } from "../../helpers/github-worker";
import { resolveGitHubTrackerConfig } from "../../helpers/tracker-config";
import { assertImplementationComment, assertTicketState } from "../../helpers/tracker-lifecycle";
import { TRACKER_STATUS_SETTINGS, TRACKER_UNRELATED_LABEL } from "../../helpers/tracker-scenario";
import { GitHub } from "../../providers/github";
import { GitHubTracker } from "../../providers/github-tracker";
import type { TrackerTicket } from "../../providers/tracker";

const enabled = process.env.DEVINTERN_E2E_GITHUB_TRACKER === "1";

/** Label the worker's ready-tasks query selects on. */
const TRIGGER_LABEL = "e2e-worker-ready";

describe.skipIf(!enabled)("GitHub Issues worker polling built CLI E2E", () => {
  test("polls a labelled issue, opens a PR, moves status labels, and does not repeat it", async () => {
    const config = resolveGitHubTrackerConfig();
    const github = new GitHub(config.repository, config.token);
    const statusLabels = [
      ...new Set([...config.statusLabels, ...Object.values(TRACKER_STATUS_SETTINGS)]),
    ];
    const tracker = new GitHubTracker(config.repository, config.token, statusLabels);
    // Continuous alphanumeric so GitHub search treats it as one term.
    const marker = `E2EWORKERMARKER${crypto.randomUUID().replace(/-/g, "")}`;
    const worker = new GitHubWorkerFixture(github, config.token, {
      // Each poll is one search request; GitHub search allows 30 per minute.
      pollIntervalSeconds: 5,
      issues: {
        query: `is:open label:${TRIGGER_LABEL} ${marker}`,
        statuses: TRACKER_STATUS_SETTINGS,
        statusLabels,
      },
      env: { E2E_EXPECT_DESCRIPTION_MARKER: marker },
    });
    const title = `E2E ${worker.shortId} Expand the greeting`;
    const tickets: TrackerTicket[] = [];
    const errors: unknown[] = [];
    try {
      await worker.setup();
      await tracker.ensureLabels([
        TRIGGER_LABEL,
        TRACKER_UNRELATED_LABEL,
        ...Object.values(TRACKER_STATUS_SETTINGS),
      ]);
      // The decoy carries the marker but not the trigger label, so only the
      // label in the worker's own query keeps it out.
      const decoy = await tracker.createTicket({
        title: `${title} (decoy)`,
        body: `# Decoy\n\nThis issue lacks the trigger label and must stay untouched.\n\n${marker}\n`,
      });
      tickets.push(decoy);
      const ticket = await tracker.createTicket({
        title,
        body: `# ${title}\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
        labels: [TRIGGER_LABEL, TRACKER_UNRELATED_LABEL, TRACKER_STATUS_SETTINGS.todoStatus],
      });
      tickets.push(ticket);
      worker.ownBranch(`feature/${ticket.key}`);

      worker.start();
      await worker.waitForReady();
      // Search indexing plus one poll: allow a generous window.
      const run = await worker.waitFor(
        `the worker to finish issue #${ticket.key}`,
        () =>
          worker
            .runRecords(ticket.key)
            .find((record) => record.status === "succeeded" || record.status === "failed"),
        180_000,
        500,
      );
      if (run.branch) worker.ownBranch(run.branch);
      expect(run.status, worker.tail()).toBe("succeeded");
      expect(run.origin).toBe("task");
      expect(run.pr_url).toBeTruthy();

      const pull = await worker.waitForPull(run.branch ?? `feature/${ticket.key}`);
      expect(pull.state).toBe("open");
      expect(pull.base.ref).toBe(worker.base);
      expect(pull.title).toBe(`[${ticket.key}] ${title}`);
      const files = await github.request<Array<{ filename: string }>>(
        `/pulls/${pull.number}/files`,
      );
      expect(files.map((file) => file.filename)).toEqual(["src/greeting.ts"]);
      expect(await worker.branchFile(pull.head.ref, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";\n',
      );

      // Tracker state is read back through the API, not from worker output.
      const state = await tracker.getTicket(ticket.key);
      assertTicketState({
        ticket: state,
        openState: tracker.openState,
        descriptionMarker: marker,
        statuses: TRACKER_STATUS_SETTINGS,
        seedLabels: [TRIGGER_LABEL, TRACKER_UNRELATED_LABEL],
      });
      assertImplementationComment(await tracker.listComments(ticket.key));

      // The label transitions updated the issue, but the actioned marker keeps
      // the next polls from implementing it again.
      await worker.waitForOutput(
        new RegExp(`skipping ${ticket.key} \\(already actioned`),
        60_000,
        "a later poll to skip the actioned issue",
      );
      expect(worker.agentInvocations(), worker.tail()).toEqual([{ mode: "implement" }]);
      expect(worker.runRecords(ticket.key)).toHaveLength(1);

      // The decoy outside the label selector is untouched.
      expect(worker.runRecords(decoy.key)).toEqual([]);
      const decoyState = await tracker.getTicket(decoy.key);
      expect(decoyState.state).toBe(tracker.openState);
      expect(decoyState.labels).toEqual([]);
      expect(await tracker.listComments(decoy.key)).toEqual([]);
      expect(worker.running).toBe(true);
    } catch (error) {
      errors.push(error);
    } finally {
      for (const ticket of tickets) {
        try {
          await tracker.closeTicket(ticket.key);
        } catch (error) {
          errors.push(new Error(`could not close issue #${ticket.key}`, { cause: error }));
        }
      }
      try {
        await worker.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(
        errors.map((error) =>
          error instanceof Error
            ? new Error(redact(error.message, config.token), { cause: error })
            : error,
        ),
        redact(
          `GitHub Issues worker scenario failed: ${worker.id}; issues ${
            tickets.map((ticket) => `#${ticket.key}`).join(", ") || "none"
          }; branches ${[...worker.ownedBranches].join(", ")}\n${worker.tail()}`,
          config.token,
        ),
      );
    }
  }, 300_000);
});
