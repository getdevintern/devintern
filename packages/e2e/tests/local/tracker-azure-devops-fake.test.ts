import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import {
  assertImplementationComment,
  assertTicketState,
  IMPLEMENTATION_COMMENT_MARKER,
} from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings, TRACKER_UNRELATED_LABEL } from "../../helpers/tracker-scenario";
import type { TrackerStatusSettings } from "../../helpers/tracker-scenario";
import type { TrackerTicket } from "../../providers/tracker";
import { FakeAzureDevOpsTracker } from "../../providers/fake-azure-devops";

interface AzureDevOpsSeed {
  issue: TrackerTicket;
  decoy: TrackerTicket;
  commentId: string;
  descriptionMarker: string;
  commentMarker: string;
  decoyMarker: string;
}

/**
 * Seed the expected work item and a decoy outside the selector.
 *
 * The marker goes into `System.Tags` (and the description) so the scenario's
 * WIQL tag filter can select the expected item without matching the decoy.
 *
 * The lifecycle test configures the same state for `inProgressStatus` and
 * `prStatus`: the local bare remote is not a supported code host, so the CLI
 * can push its branch but cannot complete the PR that would trigger a separate
 * post-PR transition. The run still exercises the real state PATCH endpoint.
 */
async function seedAzureDevOpsScenario(tracker: FakeAzureDevOpsTracker): Promise<AzureDevOpsSeed> {
  const token = crypto.randomUUID().replace(/-/g, "");
  const descriptionMarker = `E2EDESCRIPTIONMARKER${token}`;
  const commentMarker = `E2ECOMMENTMARKER${token}`;
  const decoyMarker = `E2EDECOY${token}`;

  const decoy = await tracker.createTicket({
    title: "Expand the greeting (decoy)",
    body: `# Decoy\n\nThis work item is outside the scenario selector and must stay untouched.\n\n${decoyMarker}\n`,
  });
  const issue = await tracker.createTicket({
    title: "Expand the greeting",
    body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${descriptionMarker}\n`,
    labels: [TRACKER_UNRELATED_LABEL, descriptionMarker],
  });
  const commentId = await tracker.addComment(
    issue.key,
    `Please keep the change minimal.\n\n${commentMarker}\n`,
  );
  return { issue, decoy, commentId, descriptionMarker, commentMarker, decoyMarker };
}

/** Write the per-project Azure DevOps states the CLI applies during the run. */
function writeAzureDevOpsSettings(
  run: FixtureWorkspace,
  project: string,
  statuses: Required<TrackerStatusSettings>,
): void {
  const settingsDir = join(run.cwd, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(buildTrackerSettings("azure-devops", project, statuses), null, 2)}\n`,
  );
}

/** Initialize the isolated local bare remote and prepare the CLI workspace. */
async function prepareAzureDevOpsWorkspace(
  run: FixtureWorkspace,
  tracker: FakeAzureDevOpsTracker,
  seed: AzureDevOpsSeed,
  statuses: Required<TrackerStatusSettings>,
): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", {
    ...tracker.environment(),
    E2E_EXPECT_DESCRIPTION_MARKER: seed.descriptionMarker,
    E2E_EXPECT_COMMENT_MARKER: seed.commentMarker,
  });
  writeAzureDevOpsSettings(run, tracker.projectKey(), statuses);
}

/** Assert the pushed branch, diff, run record, work-item state, and comments. */
async function assertAzureDevOpsLifecycle(
  run: FixtureWorkspace,
  tracker: FakeAzureDevOpsTracker,
  seed: AzureDevOpsSeed,
  statuses: Required<TrackerStatusSettings>,
): Promise<void> {
  const key = seed.issue.key;
  const branch = `feature/${key.toLowerCase()}`;

  // The CLI pushed the exact branch it created to the local bare remote.
  expect(await run.git("branch", "--show-current")).toBe(branch);
  expect(await run.remoteSha(branch)).toBe(await run.git("rev-parse", "HEAD"));
  expect(await run.git("diff", "--name-only", `${run.base}...HEAD`)).toBe("src/greeting.ts");
  expect(await run.git("show", "HEAD:src/greeting.ts")).toBe(
    'export const greeting = "Hello, world!";',
  );

  // Exactly the selected work item produced a run; the decoy did not.
  const records = run.runRecords({ allTasks: true });
  expect(records).toHaveLength(1);
  expect(records[0]?.status).toBe("succeeded");
  expect(records[0]?.tracker).toBe("azure-devops");
  expect(records[0]?.task_key).toBe(key);
  expect(records[0]?.pr_url).toBeNull();
  expect(records.some((record) => record.task_key === seed.decoy.key)).toBe(false);
  expect(await run.remoteSha(`feature/${seed.decoy.key.toLowerCase()}`)).toBeUndefined();
  expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["implement"]);

  // Read the final `System.State` back through the fake, not CLI stdout.
  const status = await tracker.getStatus(key);
  const ticket = await tracker.getTicket(key);
  expect(status).toBe(statuses.prStatus);
  assertTicketState({
    ticket,
    openState: tracker.openState,
    descriptionMarker: seed.descriptionMarker,
    statuses,
    seedLabels: [TRACKER_UNRELATED_LABEL],
    statusKind: "state",
    status,
  });

  // The implementation comment and the seeded prompt comment are durable.
  const comments = await tracker.listComments(key);
  assertImplementationComment(comments);
  expect(
    comments.filter((comment) => comment.body.includes(IMPLEMENTATION_COMMENT_MARKER)),
  ).toHaveLength(1);
  expect(comments.some((comment) => comment.body.includes(seed.commentMarker))).toBe(true);

  // The decoy has no comment, state change, or branch.
  const decoyState = await tracker.getTicket(seed.decoy.key);
  expect(await tracker.getStatus(seed.decoy.key)).toBe(statuses.todoStatus);
  expect(decoyState.body).toContain(seed.decoyMarker);
  expect(decoyState.body).not.toContain(seed.descriptionMarker);
  expect(await tracker.listComments(seed.decoy.key)).toEqual([]);

  expect(tracker.unexpectedRequests).toEqual([]);
}

/**
 * Close/delete the scenario's fake state before stopping the in-process
 * server. In-process state disappears with the server, but recording the
 * ownership path keeps cleanup errors visible if the fake changes.
 */
async function cleanupFake(
  tracker: FakeAzureDevOpsTracker,
  seed: AzureDevOpsSeed | undefined,
): Promise<void> {
  const failures: string[] = [];
  if (seed) {
    try {
      await tracker.deleteComment(seed.commentId);
    } catch (error) {
      failures.push(`comment ${seed.commentId}: ${String(error)}`);
    }
    for (const ticket of [seed.issue, seed.decoy]) {
      try {
        await tracker.closeTicket(ticket.key);
      } catch (error) {
        failures.push(`work item ${ticket.key}: ${String(error)}`);
      }
    }
  }
  try {
    await tracker.cleanup();
  } catch (error) {
    failures.push(`server: ${String(error)}`);
  }
  if (failures.length > 0) {
    console.warn(`Fake Azure DevOps cleanup failed:\n${failures.join("\n")}`);
  }
}

const statusesFor = (tracker: FakeAzureDevOpsTracker): Required<TrackerStatusSettings> => ({
  todoStatus: tracker.statuses.todo,
  inProgressStatus: tracker.statuses.inProgress,
  prStatus: tracker.statuses.pr,
});

/**
 * The offline lifecycle uses one actioned state for both the in-progress and
 * post-PR settings, because a local bare remote cannot create the PR that
 * would trigger a second transition.
 */
const createOfflineAzureDevOps = (): FakeAzureDevOpsTracker =>
  new FakeAzureDevOpsTracker({ statuses: { pr: "Active" } });

test.skipIf(!existsSync(cliPath))(
  "built CLI implements an Azure DevOps work item selected by key against an offline fake server",
  async () => {
    const tracker = createOfflineAzureDevOps();
    const run = new FixtureWorkspace();
    let seed: AzureDevOpsSeed | undefined;
    try {
      seed = await seedAzureDevOpsScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareAzureDevOpsWorkspace(run, tracker, seed, statuses);

      const result = await run.runTask({ taskRef: seed.issue.key, skipComments: false });
      expect(result.exitCode).toBe(0);
      await assertAzureDevOpsLifecycle(run, tracker, seed, statuses);
    } finally {
      await cleanupFake(tracker, seed);
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI selects only the marked Azure DevOps work item through --query against an offline fake server",
  async () => {
    const tracker = createOfflineAzureDevOps();
    const run = new FixtureWorkspace();
    let seed: AzureDevOpsSeed | undefined;
    try {
      seed = await seedAzureDevOpsScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareAzureDevOpsWorkspace(run, tracker, seed, statuses);

      const wiql =
        `SELECT [System.Id] FROM WorkItems WHERE ` +
        `[System.Tags] CONTAINS '${seed.descriptionMarker}' AND ` +
        `[System.State] = '${statuses.todoStatus}'`;
      const selected = await tracker.findTickets(wiql);
      expect(selected.map((ticket) => ticket.key)).toEqual([seed.issue.key]);

      const result = await run.runTask({ query: wiql, skipComments: false });
      expect(result.exitCode).toBe(0);
      await assertAzureDevOpsLifecycle(run, tracker, seed, statuses);
    } finally {
      await cleanupFake(tracker, seed);
      run.dispose();
    }
  },
  120_000,
);

test("records comment requests scoped to the wrong project as unmatched", async () => {
  const tracker = new FakeAzureDevOpsTracker();
  try {
    const ticket = await tracker.createTicket({ title: "Wrong project", body: "body" });
    const url =
      `${tracker.baseUrl}/SOME_OTHER_PROJECT/_apis/wit/workItems/${ticket.key}/comments` +
      `?api-version=7.1-preview.3`;

    const getResponse = await fetch(url);
    expect(getResponse.status).toBe(404);

    const postResponse = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "<p>wrong project</p>" }),
    });
    expect(postResponse.status).toBe(404);

    expect(tracker.unexpectedRequests).toEqual([
      `Unmatched fake Azure DevOps request: GET /fakeorg/SOME_OTHER_PROJECT/_apis/wit/workItems/${ticket.key}/comments`,
      `Unmatched fake Azure DevOps request: POST /fakeorg/SOME_OTHER_PROJECT/_apis/wit/workItems/${ticket.key}/comments`,
    ]);
  } finally {
    await tracker.cleanup();
  }
});

test("rejects unsupported WIQL operators instead of dropping the clause", async () => {
  const tracker = new FakeAzureDevOpsTracker();
  try {
    const ticket = await tracker.createTicket({
      title: "Marked work item",
      body: "body",
      labels: ["markerA"],
    });

    const unsupported =
      `SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS 'markerA' ` +
      `AND [System.Id] IN (999)`;
    await expect(tracker.findTickets(unsupported)).rejects.toThrow(
      /Unsupported fake Azure DevOps WIQL/,
    );
    expect(
      tracker.unexpectedRequests.some((entry) =>
        entry.includes("Unsupported fake Azure DevOps WIQL"),
      ),
    ).toBe(true);

    const supported =
      `SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS 'markerA' ` +
      `AND [System.State] = 'New'`;
    expect((await tracker.findTickets(supported)).map((entry) => entry.key)).toEqual([ticket.key]);
  } finally {
    await tracker.cleanup();
  }
});
