/**
 * One-shot `devintern <issue> --estimate` against GitLab Issues, fully offline.
 *
 * GitLab issues have no story-points field, so the GitLab client reports no
 * estimation field (`discoverEstimationField` → `null`) and estimation is
 * comment-only: the estimate is posted as one note
 * (`POST /projects/:id/issues/:iid/notes`) and, on a re-estimate after a
 * human edit, rewritten in place (`PUT …/notes/:note_id`) once
 * `findEstimationComment` finds the existing marker note. An unchanged issue
 * is skipped without an agent call.
 *
 * The CLI skips issues created less than 24 hours ago, so the fake backdates
 * `created_at`. The loopback fake (`providers/fake-gitlab-issues.ts`) shares
 * no code with the product client.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand, command } from "../../helpers/process";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import { FakeGitLabIssues } from "../../providers/fake-gitlab-issues";

const ESTIMATION_COMMENT_MARKER = "Automated Story Points Estimation";
const KEEP = "e2e-keep";
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const ISSUE_BODY =
  "# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n";

/** Fail if the per-run token (raw or URL-encoded) reaches CLI output. */
function expectNoToken(output: string, token: string): void {
  expect(output.includes(token)).toBe(false);
  expect(output.includes(encodeURIComponent(token))).toBe(false);
}

async function prepare(run: FixtureWorkspace, tracker: FakeGitLabIssues): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", {
    ...tracker.environment(),
    // Loopback fetches must never route through an ambient proxy.
    NO_PROXY: "127.0.0.1,localhost,::1,[::1]",
    no_proxy: "127.0.0.1,localhost,::1,[::1]",
  });
}

function runEstimate(run: FixtureWorkspace, taskRef: string) {
  return run.runTask({ taskRef, skipComments: false, extraArgs: ["--estimate"] });
}

function estimationNotes(tracker: FakeGitLabIssues, iid: number) {
  return tracker.notesOf(iid).filter((note) => note.body.includes(ESTIMATION_COMMENT_MARKER));
}

/** Writes to one issue, as `METHOD suffix` relative to the project. */
function writeShapes(tracker: FakeGitLabIssues, iid: number): string[] {
  return tracker
    .writesTo(iid)
    .map((request) => `${request.method} ${request.path.replace(/^.*\/issues\//, "issues/")}`);
}

/** Estimation is read-only for git: no branch, commit, or push. */
async function assertNoGitDelivery(run: FixtureWorkspace, iid: number): Promise<void> {
  expect(await run.git("status", "--porcelain")).toBe("");
  expect(await run.git("branch", "--show-current")).toBe(run.base);
  const remoteBase = await run.remoteSha(run.base);
  expect(remoteBase).toBeDefined();
  expect(await run.git("rev-parse", "HEAD")).toBe(remoteBase!);
  expect(await run.remoteSha(`feature/${iid}`)).toBeUndefined();
}

test.skipIf(!existsSync(cliPath))(
  "--help documents GitLab estimation as comment-only",
  async () => {
    const run = new FixtureWorkspace();
    try {
      const result = await command([process.execPath, cliPath, "--help"], run.root, run.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.replace(/\s+/g, " ")).toContain(
        "GitHub and GitLab post comment-only estimates",
      );
    } finally {
      run.dispose();
    }
  },
  30_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI posts one GitLab estimation note, skips an unchanged issue, and updates the note in place",
  async () => {
    const tracker = new FakeGitLabIssues({ labels: [KEEP] });
    const run = new FixtureWorkspace();
    try {
      const createdAt = new Date(Date.now() - TWO_DAYS_MS).toISOString();
      const decoy = tracker.createIssue({
        title: "Unrelated decoy",
        description: "# Decoy\n",
        labels: [KEEP],
        createdAt,
      });
      const issue = tracker.createIssue({
        title: "Expand the greeting",
        description: ISSUE_BODY,
        labels: [KEEP],
        createdAt,
      });
      const decoyStamp = tracker.issue(decoy.iid).updated_at;
      await prepare(run, tracker);

      // 1. First estimate: one note, no field write, no other mutation.
      const first = await runEstimate(run, `#${issue.iid}`);
      const firstOutput = `${first.stdout}\n${first.stderr}`;
      expect(first.exitCode, firstOutput).toBe(0);
      // The run output states that no field is written (comment-only mode).
      expect(firstOutput).toContain("No story points field found — skipping field update");
      expect(firstOutput).not.toContain("Failed to post estimation comment");

      const notes = estimationNotes(tracker, issue.iid);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.body).toContain("**Story Points:** 3");
      expect(tracker.notesOf(issue.iid)).toHaveLength(1);
      const noteId = notes[0]!.id;
      expect(writeShapes(tracker, issue.iid)).toEqual([`POST issues/${issue.iid}/notes`]);
      expect(tracker.issue(issue.iid).description).toBe(ISSUE_BODY);
      expect(tracker.issue(issue.iid).title).toBe("Expand the greeting");
      expect(tracker.labelsOf(issue.iid)).toEqual([KEEP]);
      expect(tracker.issue(issue.iid).state).toBe("opened");

      const records = run.runRecords({ allTasks: true });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        origin: "estimate",
        status: "succeeded",
        tracker: "gitlab",
        task_key: String(issue.iid),
        pr_url: null,
      });
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["estimate"]);
      const resultFile = join(
        run.env.DEVINTERN_OUTPUT_DIR,
        String(issue.iid),
        "estimation-result.json",
      );
      expect(JSON.parse(readFileSync(resultFile, "utf8"))).toMatchObject({ storyPoints: 3 });

      // 2. Unchanged issue: skipped before the agent, no new note or update.
      const unchanged = await runEstimate(run, String(issue.iid));
      const unchangedOutput = `${unchanged.stdout}\n${unchanged.stderr}`;
      expect(unchanged.exitCode, unchangedOutput).toBe(0);
      expect(unchangedOutput).toContain("already estimated and not updated since");
      expect(run.agentInvocations()).toHaveLength(1);
      expect(run.runRecords({ allTasks: true })).toHaveLength(1);
      expect(writeShapes(tracker, issue.iid)).toEqual([`POST issues/${issue.iid}/notes`]);

      // 3. A human edit bumps `updated_at`: the same note is rewritten via PUT.
      tracker.touch(issue.iid);
      run.env.E2E_ESTIMATE_POINTS = "5";
      const updated = await runEstimate(run, String(issue.iid));
      const updatedOutput = `${updated.stdout}\n${updated.stderr}`;
      expect(updated.exitCode, updatedOutput).toBe(0);
      expect(updatedOutput).toContain("Re-estimating");
      const updatedNotes = estimationNotes(tracker, issue.iid);
      expect(updatedNotes.map((note) => note.id)).toEqual([noteId]);
      expect(updatedNotes[0]!.body).toContain("**Story Points:** 5");
      expect(updatedNotes[0]!.body).not.toContain("**Story Points:** 3");
      expect(writeShapes(tracker, issue.iid)).toEqual([
        `POST issues/${issue.iid}/notes`,
        `PUT issues/${issue.iid}/notes/${noteId}`,
      ]);
      expect(tracker.labelsOf(issue.iid)).toEqual([KEEP]);
      expect(tracker.issue(issue.iid).description).toBe(ISSUE_BODY);
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual([
        "estimate",
        "estimate",
      ]);
      expect(run.runRecords({ allTasks: true }).map((record) => record.origin)).toEqual([
        "estimate",
        "estimate",
      ]);

      // The decoy outside the selector was never written to.
      expect(tracker.writesTo(decoy.iid)).toEqual([]);
      expect(tracker.notesOf(decoy.iid)).toEqual([]);
      expect(tracker.labelsOf(decoy.iid)).toEqual([KEEP]);
      expect(tracker.issue(decoy.iid).updated_at).toBe(decoyStamp);

      await assertNoGitDelivery(run, issue.iid);
      expect(tracker.unexpectedRequests).toEqual([]);
      expect(tracker.requests().every((request) => request.status !== 401)).toBe(true);
      for (const output of [firstOutput, unchangedOutput, updatedOutput]) {
        expectNoToken(output, tracker.token);
      }
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  150_000,
);
