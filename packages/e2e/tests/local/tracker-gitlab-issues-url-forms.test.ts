/**
 * GitLab issue URLs as positional task arguments, fully offline.
 *
 * `normalizeTaskKeys` rewrites each argument through
 * `parseGitLabIssueReference` before anything is fetched, so a pasted issue
 * URL must run exactly like the bare iid: same `feature/<iid>` branch, run
 * record keyed by the iid, status-label swap and implementation note on that
 * issue only. One batch invocation covers three URL shapes, each pointing at a
 * different issue with its own prompt marker so a mis-resolved URL cannot hide
 * behind identical edits.
 *
 * Only the iid is taken from the URL; host and project path are not compared
 * with `GITLAB_BASE_URL`/`GITLAB_PROJECT` (recorded as a limitation in the
 * area file, not asserted). A `/-/work_items/<iid>` URL is not recognized and
 * fails with the client's documented error.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand, command } from "../../helpers/process";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import { IMPLEMENTATION_COMMENT_MARKER } from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { FakeGitLabIssues } from "../../providers/fake-gitlab-issues";

const STATUS = { todo: "e2e-todo", inProgress: "e2e-in-progress" } as const;
/** A non-status label that must survive every transition. */
const KEEP = "e2e-keep";

function promptMarker(): string {
  return `E2EPROMPTMARKER${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`;
}

function expectNoToken(output: string, token: string): void {
  expect(output.includes(token)).toBe(false);
  expect(output.includes(encodeURIComponent(token))).toBe(false);
}

/**
 * Prepare the fixture against a local bare remote and commit the per-project
 * status labels on the base branch, so every task in the batch reads them
 * from its checkout. `prStatus` equals `inProgressStatus`: the bare remote
 * opens no PR.
 */
async function prepare(run: FixtureWorkspace, tracker: FakeGitLabIssues): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", {
    ...tracker.environment(),
    GITLAB_STATUS_LABELS: `${STATUS.todo},${STATUS.inProgress}`,
    NO_PROXY: "127.0.0.1,localhost,::1,[::1]",
    no_proxy: "127.0.0.1,localhost,::1,[::1]",
  });
  const settingsDir = join(run.cwd, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(
      buildTrackerSettings("gitlab", tracker.projectPath, {
        todoStatus: STATUS.todo,
        inProgressStatus: STATUS.inProgress,
        prStatus: STATUS.inProgress,
      }),
      null,
      2,
    )}\n`,
  );
  await run.git("add", "--force", ".devintern-code/settings.json");
  await run.git("commit", "-m", "Configure GitLab status labels");
  await run.git("push", "origin", run.base);
}

/** Run the built CLI with several positional task references in one batch. */
function runBatch(run: FixtureWorkspace, taskRefs: string[]) {
  return command(
    [
      process.execPath,
      cliPath,
      ...taskRefs,
      "--agent-path",
      join(run.root, "bin/agent.ts"),
      "--skip-clarity-check",
      "--create-pr",
      "--pr-target-branch",
      run.base,
      "--hook-retries",
      "0",
      "--no-update",
    ],
    run.cwd,
    { ...run.env, E2E_AGENT_MODE: "implement" },
  );
}

test.skipIf(!existsSync(cliPath))(
  "built CLI resolves GitLab issue URLs (with /-/, legacy with a trailing slash, with query and #note fragment) to the same issue as the iid",
  async () => {
    const tracker = new FakeGitLabIssues({ labels: [STATUS.todo, STATUS.inProgress, KEEP] });
    const run = new FixtureWorkspace();
    try {
      const decoy = tracker.createIssue({
        title: "Unrelated decoy",
        description: "# Decoy\n\nMust stay untouched.\n",
        labels: [STATUS.todo, KEEP],
      });
      const decoyStamp = tracker.issue(decoy.iid).updated_at;
      const markers = [promptMarker(), promptMarker(), promptMarker()];
      const issues = markers.map((marker, index) =>
        tracker.createIssue({
          title: `Expand the greeting ${index + 1}`,
          description: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
          labels: [STATUS.todo, KEEP],
        }),
      );
      const project = `${tracker.baseUrl}/${tracker.projectPath}`;
      const refs = [
        `${project}/-/issues/${issues[0]!.iid}`,
        `${project}/issues/${issues[1]!.iid}/`,
        `${project}/-/issues/${issues[2]!.iid}?scope=all#note_4242`,
      ];
      await prepare(run, tracker);

      const result = await runBatch(run, refs);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode, output).toBe(0);
      expectNoToken(output, tracker.token);

      // Each URL produced exactly one run keyed by the bare iid, in order.
      const records = run.runRecords({ allTasks: true });
      expect(records.map((record) => record.task_key)).toEqual(
        issues.map((issue) => String(issue.iid)),
      );
      expect(records.every((record) => record.status === "succeeded")).toBe(true);
      expect(records.every((record) => record.tracker === "gitlab")).toBe(true);
      // Each prompt carried its own issue's description.
      expect(run.agentInvocations().map((invocation) => invocation.promptMarkers)).toEqual(
        markers.map((marker) => [marker]),
      );

      for (const issue of issues) {
        const branch = `feature/${issue.iid}`;
        expect(await run.remoteSha(branch)).toBeDefined();
        expect(await run.git("diff", "--name-only", `${run.base}...origin/${branch}`)).toBe(
          "src/greeting.ts",
        );
        const labels = tracker.labelsOf(issue.iid);
        expect(labels).toContain(STATUS.inProgress);
        expect(labels).not.toContain(STATUS.todo);
        expect(labels).toContain(KEEP);
        expect(tracker.issue(issue.iid).state).toBe("opened");
        expect(
          tracker
            .notesOf(issue.iid)
            .filter((note) => note.body.includes(IMPLEMENTATION_COMMENT_MARKER)),
        ).toHaveLength(1);
      }

      // The decoy shares the ready label but was never selected.
      expect(tracker.writesTo(decoy.iid)).toEqual([]);
      expect(tracker.notesOf(decoy.iid)).toEqual([]);
      expect(tracker.labelsOf(decoy.iid)).toEqual([STATUS.todo, KEEP]);
      expect(tracker.issue(decoy.iid).updated_at).toBe(decoyStamp);
      expect(await run.remoteSha(`feature/${decoy.iid}`)).toBeUndefined();
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  180_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI rejects a GitLab /-/work_items/ URL with the documented error and writes nothing",
  async () => {
    const tracker = new FakeGitLabIssues({ labels: [STATUS.todo, STATUS.inProgress, KEEP] });
    const run = new FixtureWorkspace();
    try {
      const issue = tracker.createIssue({
        title: "Expand the greeting",
        description: "# Expand the greeting\n",
        labels: [STATUS.todo, KEEP],
      });
      await prepare(run, tracker);

      const ref = `${tracker.baseUrl}/${tracker.projectPath}/-/work_items/${issue.iid}`;
      const result = await runBatch(run, [ref]);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode, output).not.toBe(0);
      expect(output).toContain(`Invalid GitLab issue reference: "${ref}"`);
      expectNoToken(output, tracker.token);

      expect(run.agentInvocations()).toEqual([]);
      expect(tracker.writesTo(issue.iid)).toEqual([]);
      expect(tracker.labelsOf(issue.iid)).toEqual([STATUS.todo, KEEP]);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  60_000,
);
