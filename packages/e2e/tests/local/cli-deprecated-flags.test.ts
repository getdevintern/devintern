/**
 * Hidden deprecated `devintern` flag aliases and `--verbose`.
 *
 * Drives the built CLI against the offline fake Jira with an explicit argv
 * (not `FixtureWorkspace.runTask`, which always passes the canonical
 * `--agent-path` / `--skip-comments` / `--query` flags). The agent is an argv
 * recorder that delegates to the deterministic fixture agent, so routing
 * through `--claude-path` is observed from the recorder's log.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { recordedArgv, writeArgvRecorder } from "../../helpers/argv-recorder";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import {
  createOfflineJira,
  prepareJiraWorkspace,
  seedJiraScenario,
  statusesFor,
} from "../../helpers/offline-jira";
import type { JiraSeed } from "../../helpers/offline-jira";
import { command } from "../../helpers/process";
import { assertImplementationComment } from "../../helpers/tracker-lifecycle";
import type { FakeJiraTracker } from "../../providers/fake-jira";

const JQL_WARNING = "⚠️  --jql is deprecated, use --query instead";
const SKIP_JIRA_COMMENTS_WARNING =
  "⚠️  --skip-jira-comments is deprecated, use --skip-comments instead";

interface Scenario {
  run: FixtureWorkspace;
  seed: JiraSeed;
  /** Recorder stub passed as `--claude-path`. */
  stub: string;
  /** JSON-lines log of every argv the stub received. */
  argvLog: string;
}

/** Seed the fake Jira, prepare the workspace, and install the recorder stub. */
async function prepareScenario(run: FixtureWorkspace, tracker: FakeJiraTracker): Promise<Scenario> {
  const seed = await seedJiraScenario(tracker);
  await prepareJiraWorkspace(run, tracker, seed, statusesFor(tracker));
  const dir = join(run.root, "claude-path");
  mkdirSync(dir);
  const stub = join(dir, "recording-agent.ts");
  const argvLog = join(run.root, "claude-path-argv.jsonl");
  writeArgvRecorder(stub, join(run.root, "bin/agent.ts"), argvLog);
  return { run, seed, stub, argvLog };
}

/** Run the built CLI with only the given selection/alias flags plus fixture defaults. */
function runCli(scenario: Scenario, args: string[]) {
  const { run } = scenario;
  return command(
    [
      process.execPath,
      cliPath,
      ...args,
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

/** Combined CLI output for line assertions. */
const output = (result: { stdout: string; stderr: string }) => `${result.stdout}\n${result.stderr}`;

test.skipIf(!existsSync(cliPath))(
  "--jql selects like --query, --claude-path routes like --agent-path, and --verbose is accepted",
  async () => {
    const tracker = createOfflineJira();
    const run = new FixtureWorkspace();
    try {
      const scenario = await prepareScenario(run, tracker);
      const { seed } = scenario;
      const jql = `text ~ "${seed.descriptionMarker}"`;

      const result = await runCli(scenario, [
        "--jql",
        jql,
        "--claude-path",
        scenario.stub,
        "--verbose",
      ]);
      const text = output(result);
      expect(result.exitCode, text).toBe(0);
      expect(result.stderr).toContain(JQL_WARNING);
      expect(text).not.toContain(SKIP_JIRA_COMMENTS_WARNING);
      // --verbose prints the resolved harness path, which is the --claude-path stub.
      expect(result.stdout).toContain(`resolved to: ${scenario.stub}`);

      // The stub was the agent: one implementation turn went through it.
      expect(recordedArgv(scenario.argvLog)).toHaveLength(1);
      expect(run.agentInvocations().map((entry) => entry.mode)).toEqual(["implement"]);

      // The JQL alias went to the fake's search and selected only the issue.
      expect(tracker.searches).toContain(jql);
      const records = run.runRecords({ allTasks: true });
      expect(records.map((record) => [record.task_key, record.status])).toEqual([
        [seed.issue.key, "succeeded"],
      ]);
      const branch = `feature/${seed.issue.key.toLowerCase()}`;
      expect(await run.remoteSha(branch)).toBe(await run.git("rev-parse", "HEAD"));
      expect(await run.remoteSha(`feature/${seed.decoy.key.toLowerCase()}`)).toBeUndefined();

      // Comments stay on (no skip flag): the issue gets the implementation
      // comment, the decoy stays untouched.
      assertImplementationComment(await tracker.listComments(seed.issue.key));
      expect(await tracker.listComments(seed.decoy.key)).toEqual([]);
      expect(await tracker.getStatus(seed.decoy.key)).toBe(tracker.statuses.todo);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  90_000,
);

test.skipIf(!existsSync(cliPath))(
  "--skip-jira-comments behaves as --skip-comments and posts no Jira comment",
  async () => {
    const tracker = createOfflineJira();
    const run = new FixtureWorkspace();
    try {
      const scenario = await prepareScenario(run, tracker);
      const { seed } = scenario;
      const before = await tracker.listComments(seed.issue.key);
      const statusBefore = await tracker.getStatus(seed.issue.key);

      const result = await runCli(scenario, [
        seed.issue.key,
        "--agent-path",
        scenario.stub,
        "--skip-jira-comments",
      ]);
      const text = output(result);
      expect(result.exitCode, text).toBe(0);
      expect(result.stderr).toContain(SKIP_JIRA_COMMENTS_WARNING);
      expect(text).not.toContain(JQL_WARNING);
      expect(recordedArgv(scenario.argvLog)).toHaveLength(1);

      // The task still ran and delivered, but the tracker got no new comment
      // and no status transition, exactly as with --skip-comments.
      expect(run.runRecords({ allTasks: true }).map((record) => record.status)).toEqual([
        "succeeded",
      ]);
      expect(await run.remoteSha(`feature/${seed.issue.key.toLowerCase()}`)).toBe(
        await run.git("rev-parse", "HEAD"),
      );
      const after = await tracker.listComments(seed.issue.key);
      expect(after.map((comment) => comment.id)).toEqual(before.map((comment) => comment.id));
      expect(await tracker.getStatus(seed.issue.key)).toBe(statusBefore);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  90_000,
);
