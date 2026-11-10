import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TrackerTicket } from "../providers/tracker";
import { FakeJiraTracker } from "../providers/fake-jira";
import { checkedCommand } from "./process";
import { FixtureWorkspace } from "./fixture-workspace";
import { buildTrackerSettings, TRACKER_UNRELATED_LABEL } from "./tracker-scenario";
import type { TrackerStatusSettings } from "./tracker-scenario";

/** Markers and tickets seeded for an offline Jira lifecycle scenario. */
export interface JiraSeed {
  issue: TrackerTicket;
  decoy: TrackerTicket;
  descriptionMarker: string;
  commentMarker: string;
  decoyMarker: string;
}

/**
 * Seed the expected issue and a decoy outside the selector.
 *
 * The offline lifecycle configures the same workflow name for
 * `inProgressStatus` and `prStatus`: the local bare remote is not a supported
 * code host, so the CLI can push its branch but cannot complete the PR that
 * triggers a separate post-PR transition. The run still exercises the real
 * transition endpoint (todo -> actioned status).
 */
export async function seedJiraScenario(tracker: FakeJiraTracker): Promise<JiraSeed> {
  const token = crypto.randomUUID().replace(/-/g, "");
  const descriptionMarker = `E2EDESCRIPTIONMARKER${token}`;
  const commentMarker = `E2ECOMMENTMARKER${token}`;
  const decoyMarker = `E2EDECOY${token}`;

  const decoy = await tracker.createTicket({
    title: "Expand the greeting (decoy)",
    body: `# Decoy\n\nThis ticket is outside the scenario selector and must stay untouched.\n\n${decoyMarker}\n`,
  });
  const issue = await tracker.createTicket({
    title: "Expand the greeting",
    body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${descriptionMarker}\n`,
    labels: [TRACKER_UNRELATED_LABEL],
  });
  await tracker.addComment(issue.key, `Please keep the change minimal.\n\n${commentMarker}\n`);
  return { issue, decoy, descriptionMarker, commentMarker, decoyMarker };
}

/** Write the per-project Jira statuses the CLI applies during the run. */
export function writeJiraSettings(
  run: FixtureWorkspace,
  projectKey: string,
  statuses: Required<TrackerStatusSettings>,
): void {
  const settingsDir = join(run.cwd, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(buildTrackerSettings("jira", projectKey, statuses), null, 2)}\n`,
  );
}

/** Initialize the isolated local bare remote and prepare the CLI workspace. */
export async function prepareJiraWorkspace(
  run: FixtureWorkspace,
  tracker: FakeJiraTracker,
  seed: JiraSeed,
  statuses: Required<TrackerStatusSettings>,
): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", {
    ...tracker.environment(),
    E2E_EXPECT_DESCRIPTION_MARKER: seed.descriptionMarker,
    E2E_EXPECT_COMMENT_MARKER: seed.commentMarker,
  });
  writeJiraSettings(run, tracker.projectKey(), statuses);
}

/** Derive the per-project status settings from the fake's workflow names. */
export const statusesFor = (tracker: FakeJiraTracker): Required<TrackerStatusSettings> => ({
  todoStatus: tracker.statuses.todo,
  inProgressStatus: tracker.statuses.inProgress,
  prStatus: tracker.statuses.pr,
});

/**
 * The offline lifecycle uses one actioned workflow status for both the
 * in-progress and post-PR settings, because a local bare remote cannot create
 * the PR that would trigger a second transition.
 */
export const createOfflineJira = (): FakeJiraTracker =>
  new FakeJiraTracker({ statuses: { pr: "In Progress" } });
