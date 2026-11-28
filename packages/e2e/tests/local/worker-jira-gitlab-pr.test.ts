/**
 * Worker Jira polling through an offline GitLab forge: the PR path.
 *
 * `worker-jira-polling.test.ts` runs against a bare remote, so no PR is ever
 * opened and only the no-PR actioned marker (`recordActionedWithoutPr`) is
 * covered. Here the repo remote is a loopback GitLab project
 * (`helpers/fake-gitlab-forge.ts` with `mergeRequestCreation`), rewritten
 * onto the local bare repository with a git `insteadOf`, so the real
 * `GitLabMRClient` opens an MR. After the MR the worker moves the ticket to the
 * project's `prStatus` and records the PR-created actioned marker
 * (`applyActionedTransition` in `task/actioned-transition.ts`), and the
 * acquirer's actioned gate skips the ticket until a human edits it. Per
 * docs/code/worker-troubleshooting.md an edited description re-arms it, and
 * the test asserts exactly one re-run that never reopens an MR from the same
 * source branch.
 *
 * Every server is a loopback fake owned by the test, and a refusing recording
 * proxy proves nothing else was contacted.
 */

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  FAKE_GITLAB_PROJECT_PATH,
  FakeGitlabForge,
  installForgeGitRewrite,
} from "../../helpers/fake-gitlab-forge";
import { statusesFor } from "../../helpers/offline-jira";
import { checkedCommand } from "../../helpers/process";
import { proxyEnvironment, startRecordingProxy } from "../../helpers/recording-proxy";
import type { RecordingProxy } from "../../helpers/recording-proxy";
import { IMPLEMENTATION_COMMENT_MARKER } from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { randomToken } from "../../helpers/worker-doctor";
import { FakeJiraTracker } from "../../providers/fake-jira";

const SOURCE = "jira";
/** Poll ticks to observe after each settled state, proving nothing else runs. */
const QUIET_TICKS = 3;
/** Served by the forge; the second label is not, so the client skips it. */
const SERVED_LABEL = "devintern";
const MISSING_LABEL = "e2e-missing-label";

function redact(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.replaceAll(secret, "[redacted]");
    redacted = redacted.replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return redacted;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** `POST merge_requests` calls the forge saw (created or answered 409). */
function mergeRequestPosts(forge: FakeGitlabForge): number {
  return forge
    .mutations()
    .filter((request) => request.method === "POST" && request.path.endsWith("/merge_requests"))
    .length;
}

/** `agent_prs` rows the worker registered for review polling. */
function agentPrs(dbPath: string): Array<{ provider: string; web_url: string; branch: string }> {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    return db
      .query("SELECT provider, web_url, branch FROM agent_prs ORDER BY rowid")
      .all() as Array<{
      provider: string;
      web_url: string;
      branch: string;
    }>;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Recursively list files under `dir`, skipping git object stores. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry.endsWith(".git") || entry === "node_modules") continue;
    const path = join(dir, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) files.push(...listFiles(path));
    else if (stats.isFile()) files.push(path);
  }
  return files;
}

/** Wait until the worker has evaluated the user query `ticks` more times. */
async function waitForTicks(
  worker: WorkerFixture,
  tracker: FakeJiraTracker,
  query: string,
  ticks: number,
): Promise<void> {
  const target = tracker.searches.filter((jql) => jql === query).length + ticks;
  await worker.waitFor(
    `${ticks} more poll tick(s)`,
    () => (tracker.searches.filter((jql) => jql === query).length >= target ? true : undefined),
    30_000,
  );
}

test.skipIf(!existsSync(cliPath))(
  "worker opens one GitLab MR for a polled Jira ticket, moves it to review, and skips it as PR-actioned",
  async () => {
    const gitBin = Bun.which("git");
    if (!gitBin) throw new Error("git is required for the forge fixture");
    const jiraToken = randomToken("E2EJIRA");
    const forgeToken = randomToken("E2EGITLAB");
    const secrets = [jiraToken, forgeToken];
    const marker = `E2EPRPOLL${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`;
    const query = `text ~ "${marker}"`;

    // Resources are recorded as they are created and released in finally.
    // Distinct In Progress and In Review statuses (the fake's defaults), so the
    // post-PR transition is visible as its own step.
    const tracker = new FakeJiraTracker({ wallClock: true });
    let proxy: RecordingProxy | undefined;
    let worker: WorkerFixture | undefined;
    let forge: FakeGitlabForge | undefined;
    let failure: unknown;
    try {
      proxy = await startRecordingProxy();
      worker = new WorkerFixture({
        tracker: "jira",
        // No --skip-comments: the run must comment on and transition the ticket.
        workerTaskArgs: "--create-pr --skip-clarity-check",
        workspaceTomlExtra: [`task_query = ${JSON.stringify(query)}`, "poll_interval = 1"].join(
          "\n",
        ),
        repoTomlExtra: {
          fixture: `pr_labels = ${JSON.stringify([SERVED_LABEL, MISSING_LABEL])}`,
        },
        env: {
          ...tracker.environment(),
          // The fake accepts any Basic credentials; use a per-test dummy.
          JIRA_API_TOKEN: jiraToken,
          ...proxyEnvironment(proxy.url),
        },
      });
      const w = worker;

      const issue = await tracker.createTicket({
        title: "Expand the greeting",
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
      });
      const branch = `feature/${issue.key.toLowerCase()}`;

      await w.prepare();
      // Project settings travel with the repo; the fixture ignores the
      // directory, so force-add the per-project Jira statuses.
      const statuses = statusesFor(tracker);
      expect(statuses.prStatus).not.toBe(statuses.inProgressStatus);
      const settingsDir = join(w.seed, ".devintern-code");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.json"),
        `${JSON.stringify(buildTrackerSettings("jira", tracker.projectKey(), statuses), null, 2)}\n`,
      );
      const seedGit = (...args: string[]) => checkedCommand(["git", ...args], w.seed, w.env);
      await seedGit("add", "-f", ".devintern-code/settings.json");
      await seedGit("commit", "-m", "Add Jira project settings");
      await seedGit("push");

      forge = new FakeGitlabForge({
        gitDir: w.remote,
        gitBin,
        sourceBranch: branch,
        targetBranch: w.baseBranch,
        token: forgeToken,
        mergeRequestCreation: { labels: [SERVED_LABEL] },
      });
      const f = forge;
      const remoteUrl = `${f.baseUrl}/${FAKE_GITLAB_PROJECT_PATH}.git`;
      Object.assign(w.env, {
        DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
        GITLAB_CODE_HOST_URL: f.baseUrl,
        GITLAB_CODE_HOST_TOKEN: forgeToken,
      });
      installForgeGitRewrite(w, gitBin, remoteUrl);
      const tomlPath = join(w.workspaceDir, "workspace.toml");
      const remoteLine = `remote = "${w.remote}"`;
      const toml = readFileSync(tomlPath, "utf8");
      if (!toml.includes(remoteLine)) throw new Error("workspace remote line was not found");
      writeFileSync(tomlPath, toml.replace(remoteLine, `remote = "${remoteUrl}"`));
      const heads = await checkedCommand(["git", "ls-remote", "--heads", remoteUrl], w.root, w.env);
      if (!heads.includes(`refs/heads/${w.baseBranch}`)) {
        throw new Error(`git insteadOf did not reach the bare remote:\n${heads}`);
      }

      const detail = () =>
        redact(
          [
            `forge requests: ${JSON.stringify(f.requests)}`,
            `forge unexpected: ${JSON.stringify(f.unexpected)}`,
            `forge auth failures: ${JSON.stringify(f.authFailures)}`,
            `merge requests: ${JSON.stringify(f.mergeRequests.map((mr) => ({ ...mr, description: mr.description.length })))}`,
            `transitions: ${JSON.stringify(tracker.transitions)}`,
            `searches: ${JSON.stringify(tracker.searches.slice(-12))}`,
            `runs: ${JSON.stringify(w.runRecords())}`,
            `actioned: ${JSON.stringify(w.actionedTask(SOURCE, issue.key))}`,
            `proxy: ${JSON.stringify(proxy?.requests() ?? [])}`,
            `jira unexpected: ${JSON.stringify(tracker.unexpectedRequests)}`,
            w.tail(),
          ].join("\n"),
          secrets,
        );

      // 1. Pickup opens exactly one MR -----------------------------------------
      w.start();
      await w.waitForReady();
      await w.waitForOutput(
        new RegExp(`\\[poll:jira\\] ${issue.key} completed`),
        90_000,
        "the polled issue to complete",
      );

      expect(f.mergeRequests, detail()).toHaveLength(1);
      const mr = f.mergeRequests[0]!;
      expect(mr.sourceBranch, detail()).toBe(branch);
      expect(mr.targetBranch, detail()).toBe(w.baseBranch);
      expect(mr.title, detail()).toContain(issue.key);
      // Only the label the project has is applied; the missing one is skipped.
      expect(mr.labels, detail()).toEqual([SERVED_LABEL]);
      expect(mergeRequestPosts(f), detail()).toBe(1);
      expect(w.logs, detail()).toContain(`Merge request created: ${mr.webUrl}`);
      expect(w.logs, detail()).toContain(
        `GitLab labels do not exist and were skipped: ${MISSING_LABEL}`,
      );
      expect(await w.branchFile(branch, "src/greeting.ts"), detail()).toContain("Hello, world!");

      // Jira: To Do -> In Progress, then the post-PR status; one summary comment.
      expect(
        tracker.transitions.filter((entry) => entry.key === issue.key).map((entry) => entry.status),
        detail(),
      ).toEqual([statuses.inProgressStatus, statuses.prStatus]);
      expect(await tracker.getStatus(issue.key), detail()).toBe(statuses.prStatus);
      const comments = await tracker.listComments(issue.key);
      expect(
        comments.filter((comment) => comment.body.includes(IMPLEMENTATION_COMMENT_MARKER)),
        detail(),
      ).toHaveLength(1);

      // Run record and review-polling registry carry the MR URL.
      const runs = w.runRecords(issue.key);
      expect(
        runs.map((run) => run.status),
        detail(),
      ).toEqual(["succeeded"]);
      expect(runs[0]?.pr_url, detail()).toBe(mr.webUrl);
      expect(agentPrs(w.dbPath), detail()).toEqual([
        { provider: "gitlab", web_url: mr.webUrl, branch },
      ]);

      // The PR-created marker: verified, transitioned to the post-PR status.
      expect(w.actionedTask(SOURCE, issue.key), detail()).toMatchObject({
        verified: 1,
        pending: 0,
        transitioned: 1,
        transition_status: statuses.prStatus,
      });
      expect(w.logs, detail()).toContain(`Recorded ${issue.key} as actioned`);
      expect(w.logs, detail()).not.toContain(`Recorded ${issue.key} as actioned (no PR)`);

      // 2. Later ticks skip it as PR-actioned ----------------------------------
      await waitForTicks(w, tracker, query, QUIET_TICKS);
      expect(w.logs, detail()).toContain(
        `skipping ${issue.key} (already actioned; no change since the PR)`,
      );
      expect(count(w.logs, `picking up ${issue.key}`), detail()).toBe(1);
      expect(w.runRecords(issue.key), detail()).toHaveLength(1);
      expect(f.mergeRequests, detail()).toHaveLength(1);
      expect(mergeRequestPosts(f), detail()).toBe(1);
      expect(await tracker.listComments(issue.key), detail()).toHaveLength(comments.length);

      // 3. A human edit re-arms it (docs/code/worker-troubleshooting.md) -----
      const stampBefore = tracker.getUpdated(issue.key);
      await tracker.editTicket(issue.key, {
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test. Also keep the export name.\n\n${marker}\n`,
      });
      expect(tracker.getUpdated(issue.key)).not.toBe(stampBefore);
      await w.waitFor(
        "the edited issue to run again",
        () =>
          w.runRecords(issue.key).length >= 2 && count(w.logs, `${issue.key} completed`) >= 2
            ? true
            : undefined,
        90_000,
      );
      await waitForTicks(w, tracker, query, QUIET_TICKS);
      expect(count(w.logs, `picking up ${issue.key}`), detail()).toBe(2);
      expect(
        w.runRecords(issue.key).map((run) => run.status),
        detail(),
      ).toEqual(["succeeded", "succeeded"]);
      // No MR is opened twice from one source branch, and the first MR is left
      // as it was. Whether the re-run should open a second MR from a fresh
      // `-attempt-N` branch (what it does today on GitLab, where the worker
      // cannot confirm the first MR is still open) or continue on the first
      // MR is recorded as an unconfirmed observation in the coverage file, so
      // the MR count after the re-run is deliberately not asserted.
      const sources = f.mergeRequests.map((entry) => entry.sourceBranch);
      expect(new Set(sources).size, detail()).toBe(sources.length);
      expect(f.mergeRequests[0], detail()).toEqual(mr);
      const rerunUrl = w.runRecords(issue.key)[1]?.pr_url ?? null;
      expect(rerunUrl, detail()).not.toBeNull();
      expect(
        f.mergeRequests.map((entry) => entry.webUrl),
        detail(),
      ).toContain(rerunUrl ?? "");
      // The re-run ends PR-actioned again, then stays quiet.
      expect(await tracker.getStatus(issue.key), detail()).toBe(statuses.prStatus);
      expect(w.actionedTask(SOURCE, issue.key), detail()).toMatchObject({
        verified: 1,
        transitioned: 1,
        transition_status: statuses.prStatus,
      });
      expect(w.logs.slice(w.logs.lastIndexOf(`${issue.key} completed`)), detail()).toContain(
        `skipping ${issue.key} (already actioned; no change since the PR)`,
      );
      expect(mergeRequestPosts(f), detail()).toBe(f.mergeRequests.length);

      // 4. Nothing unexpected, nothing left the machine, nothing leaked -------
      expect(f.unexpected, detail()).toEqual([]);
      expect(f.authFailures, detail()).toEqual([]);
      expect(tracker.unexpectedRequests, detail()).toEqual([]);
      expect(proxy.requests(), detail()).toEqual([]);
      const posted = [
        ...(await tracker.listComments(issue.key)).map((comment) => comment.body),
        ...f.mergeRequests.flatMap((entry) => [entry.title, entry.description]),
        ...f.notes,
      ];
      const leakedFiles = listFiles(w.root)
        .filter((path) => {
          const content = readFileSync(path).toString("latin1");
          return secrets.some(
            (secret) => content.includes(secret) || content.includes(encodeURIComponent(secret)),
          );
        })
        .map((path) => relative(w.root, path));
      for (const secret of secrets) {
        for (const form of [secret, encodeURIComponent(secret)]) {
          expect(w.logs.includes(form), "worker output contains a credential").toBe(false);
          expect(
            posted.some((body) => body.includes(form)),
            "a posted body contains a credential",
          ).toBe(false);
        }
      }
      expect(leakedFiles, "run artifacts contain a credential").toEqual([]);
      expect(w.running, detail()).toBe(true);
    } catch (error) {
      failure = error;
    } finally {
      const residue: string[] = [];
      const attempt = async (label: string, step: () => Promise<void> | void) => {
        try {
          await step();
        } catch (error) {
          residue.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      await attempt("worker fixture", () => worker?.dispose());
      await attempt("fake GitLab forge", () => forge?.stop());
      await attempt("fake Jira server", () => tracker.cleanup());
      await attempt("recording proxy", () => proxy?.close());
      if (residue.length > 0) {
        const residueError = new Error(
          redact(`Cleanup left residue:\n${residue.join("\n")}`, [jiraToken, forgeToken]),
        );
        if (failure) console.error(residueError.message);
        else failure = residueError;
      }
    }
    if (failure) throw failure;
  },
  // Two agent runs with 1s polling; every wait is event-driven.
  180_000,
);
