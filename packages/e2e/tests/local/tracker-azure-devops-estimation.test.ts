import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import type { TrackerTicket } from "../../providers/tracker";
import {
  AZURE_DEVOPS_STORY_POINTS_FIELD,
  FakeAzureDevOpsTracker,
} from "../../providers/fake-azure-devops";

const ESTIMATION_COMMENT_MARKER = "Automated Story Points Estimation";

/**
 * Story points as they appear in the stored comment HTML.
 *
 * The shared markdown-to-HTML converter treats the product's
 * `**Story Points:** N  |  **Confidence:** …` line as a pipe table and emits
 * it inside `<pre>` with the asterisks intact (a known rendering defect,
 * recorded in the coverage doc). Accept that and the `<strong>` rendering a
 * fix would produce, but nothing else.
 */
function storyPointsPattern(points: number): RegExp {
  return new RegExp(`(?:\\*\\*Story Points:\\*\\*|<strong>Story Points:</strong>) ${points}\\b`);
}
/** Custom field reference the `storyPointsField` override names (e.g. a Scrum `Effort`-style field). */
const CUSTOM_STORY_POINTS_FIELD = "Custom.E2EStoryPointsOverride";

const TICKET = {
  title: "Expand the greeting",
  body: "# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n",
} as const;

/**
 * Initialize the isolated local bare remote and prepare the CLI workspace.
 *
 * No `.devintern-code/settings.json` is written: Azure DevOps estimation must
 * fall back to the default `Microsoft.VSTS.Scheduling.StoryPoints` field.
 */
async function prepareEstimationWorkspace(
  run: FixtureWorkspace,
  tracker: FakeAzureDevOpsTracker,
): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", tracker.environment());
}

/**
 * Write a project-scoped `storyPointsField` override for the Azure DevOps
 * project, keyed the way users configure statuses: by the project name the
 * tracker resolves (`AZURE_DEVOPS_PROJECT`). The CLI runs with the checkout as
 * its cwd, and `.devintern-code/` is gitignored by the fixture.
 */
function writeStoryPointsFieldSettings(run: FixtureWorkspace, projectKey: string): void {
  const settingsDir = join(run.cwd, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(
      {
        "azure-devops": {
          projects: { [projectKey]: { storyPointsField: CUSTOM_STORY_POINTS_FIELD } },
        },
      },
      null,
      2,
    )}\n`,
  );
}

/** Run `devintern <id> --estimate` through the isolated fixture. */
function runEstimate(run: FixtureWorkspace, key: string, options: { skipComments?: boolean } = {}) {
  return run.runTask({
    taskRef: key,
    skipComments: options.skipComments,
    extraArgs: ["--estimate"],
  });
}

/** Estimation comments as stored by the fake (raw HTML), not the CLI's stdout. */
function estimationComments(tracker: FakeAzureDevOpsTracker, key: string) {
  return tracker
    .rawComments(key)
    .filter((comment) => comment.text.includes(ESTIMATION_COMMENT_MARKER));
}

/** Read the persisted estimation artifact from the isolated output directory. */
function readEstimationResult(run: FixtureWorkspace, key: string): unknown {
  const path = join(run.env.DEVINTERN_OUTPUT_DIR, key.toLowerCase(), "estimation-result.json");
  expect(existsSync(path)).toBe(true);
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Estimation is read-only: no branch, commit, or push reached the remote. */
async function expectNoGitDelivery(run: FixtureWorkspace, key: string): Promise<void> {
  expect(await run.git("status", "--porcelain")).toBe("");
  expect(await run.git("branch", "--show-current")).toBe(run.base);
  expect(await run.remoteSha(`feature/${key.toLowerCase()}`)).toBeUndefined();
  expect(await run.remoteSha(`feature/${key}`)).toBeUndefined();
}

test.skipIf(!existsSync(cliPath))(
  "built CLI estimates story points through the offline fake Azure DevOps server",
  async () => {
    const tracker = new FakeAzureDevOpsTracker();
    const run = new FixtureWorkspace();
    try {
      const workItem = await tracker.createTicket(TICKET);
      await prepareEstimationWorkspace(run, tracker);

      const result = await runEstimate(run, workItem.key, { skipComments: false });
      expect(result.exitCode).toBe(0);

      const records = run.runRecords({ allTasks: true });
      expect(records).toHaveLength(1);
      expect(records[0]?.origin).toBe("estimate");
      expect(records[0]?.status).toBe("succeeded");
      expect(records[0]?.task_key).toBe(workItem.key);
      expect(records[0]?.pr_url).toBeNull();

      // Default field reference name, stored as a number by the JSON patch.
      expect(tracker.getStoryPoints(workItem.key)).toBe(3);
      // State is untouched by estimation.
      expect(await tracker.getStatus(workItem.key)).toBe(tracker.statuses.todo);

      // Exactly one estimation comment, posted as HTML (Azure DevOps renders
      // comment `text` as HTML; raw markdown would show literal `**`/`###`).
      const comments = estimationComments(tracker, workItem.key);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.text).toMatch(/<h\d>[^<]*Automated Story Points Estimation<\/h\d>/);
      expect(comments[0]?.text).toContain("<strong>AI Implementation Confidence:</strong>");
      expect(comments[0]?.text).toMatch(/<h\d>Reasoning<\/h\d>/);
      expect(comments[0]?.text).not.toMatch(/^#/m);
      expect(comments[0]?.text).toMatch(storyPointsPattern(3));

      expect(readEstimationResult(run, workItem.key)).toMatchObject({
        storyPoints: 3,
        confidence: "high",
        implementationConfidence: 8,
      });
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["estimate"]);

      await expectNoGitDelivery(run, workItem.key);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI skips unchanged Azure DevOps work items and updates the estimation comment in place",
  async () => {
    const tracker = new FakeAzureDevOpsTracker();
    const run = new FixtureWorkspace();
    try {
      const workItem: TrackerTicket = await tracker.createTicket(TICKET);
      await prepareEstimationWorkspace(run, tracker);

      const first = await runEstimate(run, workItem.key, { skipComments: false });
      expect(first.exitCode).toBe(0);
      const firstComments = estimationComments(tracker, workItem.key);
      expect(firstComments).toHaveLength(1);
      const original = firstComments[0]!;
      expect(original.modifiedDate).toBe(original.createdDate);
      expect(tracker.getStoryPoints(workItem.key)).toBe(3);
      expect(run.agentInvocations()).toHaveLength(1);

      // No work-item change: the existing estimation is reused without an attempt.
      const unchanged = await runEstimate(run, workItem.key, { skipComments: false });
      expect(unchanged.exitCode).toBe(0);
      expect(run.agentInvocations()).toHaveLength(1);
      expect(estimationComments(tracker, workItem.key)).toEqual([original]);
      expect(tracker.getStoryPoints(workItem.key)).toBe(3);
      expect(run.runRecords({ allTasks: true })).toHaveLength(1);

      // A later human comment bumps `System.ChangedDate`, so the next run
      // re-estimates and edits the same comment through the comments PATCH.
      await tracker.addComment(workItem.key, "Scope changed: keep the greeting export stable.\n");
      run.env.E2E_ESTIMATE_POINTS = "5";
      const updated = await runEstimate(run, workItem.key, { skipComments: false });
      expect(updated.exitCode).toBe(0);

      const updatedComments = estimationComments(tracker, workItem.key);
      expect(updatedComments).toHaveLength(1);
      const edited = updatedComments[0]!;
      // Same comment id and creation time: edited in place, not re-posted.
      expect(edited.id).toBe(original.id);
      expect(edited.createdDate).toBe(original.createdDate);
      expect(Date.parse(edited.modifiedDate)).toBeGreaterThan(Date.parse(original.modifiedDate));
      // The in-place PATCH must rewrite the HTML body, not just reuse the id.
      expect(edited.text).toMatch(storyPointsPattern(5));
      expect(edited.text).not.toMatch(storyPointsPattern(3));
      expect(edited.text).toMatch(/<h\d>[^<]*Automated Story Points Estimation<\/h\d>/);
      expect(tracker.getStoryPoints(workItem.key)).toBe(5);
      // The human comment is preserved alongside the single estimation comment.
      expect(tracker.rawComments(workItem.key)).toHaveLength(2);
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual([
        "estimate",
        "estimate",
      ]);
      expect(run.runRecords({ allTasks: true }).map((record) => record.origin)).toEqual([
        "estimate",
        "estimate",
      ]);

      // The re-estimation's own field PATCH and comment edit bump
      // `System.ChangedDate` too; they are not a user change, so a third
      // no-change run must skip instead of estimating forever.
      const steadyState = await runEstimate(run, workItem.key, { skipComments: false });
      expect(steadyState.exitCode).toBe(0);
      expect(run.agentInvocations()).toHaveLength(2);
      expect(estimationComments(tracker, workItem.key)).toEqual([edited]);
      expect(tracker.getStoryPoints(workItem.key)).toBe(5);
      expect(run.runRecords({ allTasks: true })).toHaveLength(2);

      await expectNoGitDelivery(run, workItem.key);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  150_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI skips Azure DevOps work items created less than 24 hours ago",
  async () => {
    const tracker = new FakeAzureDevOpsTracker();
    const run = new FixtureWorkspace();
    try {
      tracker.setNow(Date.now());
      const workItem = await tracker.createTicket(TICKET);
      await prepareEstimationWorkspace(run, tracker);

      const result = await runEstimate(run, workItem.key, { skipComments: false });
      expect(result.exitCode).toBe(0);
      expect(run.agentInvocations()).toEqual([]);
      expect(tracker.rawComments(workItem.key)).toEqual([]);
      expect(tracker.getStoryPoints(workItem.key)).toBeUndefined();
      // A skipped task never starts a run, so the queue database may not exist.
      expect(
        existsSync(run.env.WEBHOOK_QUEUE_DB) ? run.runRecords({ allTasks: true }) : [],
      ).toEqual([]);
      await expectNoGitDelivery(run, workItem.key);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  90_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI writes Azure DevOps story points without a comment when --skip-comments is set",
  async () => {
    const tracker = new FakeAzureDevOpsTracker();
    const run = new FixtureWorkspace();
    try {
      const workItem = await tracker.createTicket(TICKET);
      await prepareEstimationWorkspace(run, tracker);

      const result = await runEstimate(run, workItem.key);
      expect(result.exitCode).toBe(0);
      expect(tracker.getStoryPoints(workItem.key)).toBe(3);
      expect(tracker.rawComments(workItem.key)).toEqual([]);
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["estimate"]);
      expect(readEstimationResult(run, workItem.key)).toMatchObject({ storyPoints: 3 });

      // No comment can serve as the re-estimation baseline, so the durable
      // state recorded by the first run must make a second run a no-op.
      const repeat = await runEstimate(run, workItem.key);
      expect(repeat.exitCode).toBe(0);
      expect(tracker.getStoryPoints(workItem.key)).toBe(3);
      expect(tracker.rawComments(workItem.key)).toEqual([]);
      expect(run.agentInvocations()).toHaveLength(1);
      expect(run.runRecords({ allTasks: true })).toHaveLength(1);

      await expectNoGitDelivery(run, workItem.key);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  90_000,
);

/**
 * The override is keyed by the Azure DevOps project name (`AZURE_DEVOPS_PROJECT`),
 * not the numeric work item id, so this pins that estimation resolves the
 * project the same way as the rest of the pipeline.
 */
test.skipIf(!existsSync(cliPath))(
  "built CLI writes Azure DevOps story points to the configured storyPointsField override",
  async () => {
    const tracker = new FakeAzureDevOpsTracker();
    const run = new FixtureWorkspace();
    try {
      const workItem = await tracker.createTicket(TICKET);
      await prepareEstimationWorkspace(run, tracker);
      writeStoryPointsFieldSettings(run, tracker.projectKey());

      const result = await runEstimate(run, workItem.key, { skipComments: false });
      const detail = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode, detail).toBe(0);
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["estimate"]);

      // The override receives the points; the default field is never written.
      expect(tracker.getField(workItem.key, CUSTOM_STORY_POINTS_FIELD), detail).toBe(3);
      expect(
        tracker.getField(workItem.key, AZURE_DEVOPS_STORY_POINTS_FIELD),
        detail,
      ).toBeUndefined();
      expect(detail).toContain(`Using configured story points field: ${CUSTOM_STORY_POINTS_FIELD}`);
      expect(estimationComments(tracker, workItem.key)).toHaveLength(1);

      await expectNoGitDelivery(run, workItem.key);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  90_000,
);
