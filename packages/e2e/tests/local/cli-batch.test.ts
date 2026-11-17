import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { command } from "../../helpers/process";
import type { CommandResult } from "../../helpers/process";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import {
  assertImplementationComment,
  assertProcessingFailureComment,
} from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import type { TrackerStatusSettings } from "../../helpers/tracker-scenario";
import { FakeJiraTracker } from "../../providers/fake-jira";

/** Unique, branch-safe token so batch task keys cannot collide across tests. */
function batchToken(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/**
 * Unique prompt-routing marker for one task body.
 *
 * Kept strictly alphanumeric because tracker task descriptions are
 * Markdown-escaped before they reach the agent; an underscore or other special
 * character would be rewritten and the deterministic agent could not record it.
 */
function promptMarker(): string {
  return `E2EPROMPTMARKER${batchToken().toUpperCase()}`;
}

/** Prompt markers each agent invocation reported, in batch order. */
function recordedPromptMarkers(run: FixtureWorkspace): Array<string[] | undefined> {
  return run.agentInvocations().map((invocation) => invocation.promptMarkers);
}

/** Branch the CLI derives from a sanitized task key. */
function featureBranch(taskKey: string): string {
  return `feature/${taskKey.toLowerCase()}`;
}

/**
 * Write a Markdown task whose frontmatter key drives branch naming and run
 * records. Files live outside the checkout so the pipeline's pre-branch
 * `git clean` cannot delete them between tasks.
 *
 * @param run - Fixture workspace owning the temporary root
 * @param name - File name stem inside the temporary root
 * @param key - Frontmatter task key
 * @param body - Task body passed to the deterministic agent
 */
function writeMarkdownTask(run: FixtureWorkspace, name: string, key: string, body: string): string {
  const path = join(run.root, `${name}.md`);
  writeFileSync(path, `---\nkey: ${key}\n---\n${body}\n`);
  return path;
}

/**
 * Run the built CLI with several positional task references, matching the
 * documented batch invocation instead of calling batch functions directly.
 */
function runBatch(
  run: FixtureWorkspace,
  taskRefs: string[],
  options: { skipComments?: boolean; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  return command(
    [
      process.execPath,
      cliPath,
      ...taskRefs,
      "--agent-path",
      join(run.root, "bin/agent.ts"),
      "--skip-clarity-check",
      ...(options.skipComments === false ? [] : ["--skip-comments"]),
      "--create-pr",
      "--pr-target-branch",
      run.base,
      "--hook-retries",
      "0",
      "--no-update",
    ],
    run.cwd,
    { ...run.env, ...options.env },
  );
}

/**
 * Assert the task's `feature/<key>` branch is on the bare remote with exactly
 * one commit changing the canonical greeting file.
 */
async function expectPushedImplementation(
  run: FixtureWorkspace,
  taskKey: string,
  expectedGreeting = "Hello, world!",
): Promise<void> {
  const branch = featureBranch(taskKey);
  const remoteSha = await run.remoteSha(branch);
  expect(remoteSha).toBeDefined();
  expect(remoteSha).toBe(await run.git("rev-parse", branch));
  expect(await run.git("rev-list", "--count", `${run.base}..${branch}`)).toBe("1");
  expect(await run.git("diff", "--name-only", `${run.base}...${branch}`)).toBe("src/greeting.ts");
  expect(await run.git("show", `${branch}:src/greeting.ts`)).toBe(
    `export const greeting = "${expectedGreeting}";`,
  );
}

test.skipIf(!existsSync(cliPath))(
  "built CLI processes three Markdown files in argument order with one pushed branch each",
  async () => {
    const run = new FixtureWorkspace();
    const remote = join(run.root, "remote.git");
    const token = batchToken();
    const keys = ["alpha", "bravo", "charlie"].map((name) => `e2e-batch-${name}-${token}`);
    const markers = keys.map(() => promptMarker());
    const tasks = keys.map((key, index) =>
      writeMarkdownTask(
        run,
        `batch-task-${index + 1}`,
        key,
        `# Batch task ${index + 1}\n\nChange the greeting to Hello, world! and run bun test.\n\n${markers[index]}\n`,
      ),
    );
    try {
      await command(["git", "init", "--bare", remote], run.root, run.env);
      await run.prepare(remote, "test-token", {});

      const result = await runBatch(run, tasks);
      expect(result.exitCode).toBe(0);

      // The queue database preserves positional order and one record per task.
      const records = run.runRecords({ allTasks: true });
      expect(records.map((record) => record.task_key)).toEqual(keys);
      expect(records.map((record) => record.status)).toEqual([
        "succeeded",
        "succeeded",
        "succeeded",
      ]);
      expect(records.map((record) => record.tracker)).toEqual(["markdown", "markdown", "markdown"]);

      for (const key of keys) await expectPushedImplementation(run, key);

      // Each task reached the deterministic agent exactly once, with its own
      // prompt. Identical file edits cannot hide a prompt-routing regression.
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual([
        "implement",
        "implement",
        "implement",
      ]);
      expect(recordedPromptMarkers(run)).toEqual(markers.map((marker) => [marker]));
    } finally {
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI processes a mixed Jira-key and Markdown batch without running the tracker decoy",
  async () => {
    // The local bare remote cannot complete a PR, so both the in-progress and
    // post-PR settings use the same actioned Jira status.
    const tracker = new FakeJiraTracker({ statuses: { pr: "In Progress" } });
    const run = new FixtureWorkspace();
    const remote = join(run.root, "remote.git");
    const token = batchToken();
    const jiraMarker = promptMarker();
    const markdownMarker = promptMarker();
    try {
      const decoy = await tracker.createTicket({
        title: "Expand the greeting (decoy)",
        body: "# Decoy\n\nThis ticket is outside the batch and must stay untouched.\n",
      });
      const issue = await tracker.createTicket({
        title: "Expand the greeting",
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${jiraMarker}\n`,
      });
      const statuses: Required<TrackerStatusSettings> = {
        todoStatus: tracker.statuses.todo,
        inProgressStatus: tracker.statuses.inProgress,
        prStatus: tracker.statuses.pr,
      };

      await command(["git", "init", "--bare", remote], run.root, run.env);
      await run.prepare(remote, "test-token", tracker.environment());

      // Written after prepare, like the other tracker scenarios, so the
      // pre-branch cleanup cannot remove it before settings are read.
      const settingsDir = join(run.cwd, ".devintern-code");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.json"),
        `${JSON.stringify(buildTrackerSettings("jira", tracker.projectKey(), statuses), null, 2)}\n`,
      );

      const markdownKey = `e2e-mixed-file-${token}`;
      const markdownTask = writeMarkdownTask(
        run,
        "mixed-extra-context",
        markdownKey,
        `# Expand the greeting from a local file\n\nChange the greeting to Hello, world! and run bun test.\n\n${markdownMarker}\n`,
      );

      // Documented mix order: tracker key followed by the local Markdown file.
      const result = await runBatch(run, [issue.key, markdownTask], { skipComments: false });
      expect(result.exitCode).toBe(0);

      const records = run.runRecords({ allTasks: true });
      expect(records.map((record) => record.task_key)).toEqual([issue.key, markdownKey]);
      expect(records.map((record) => record.status)).toEqual(["succeeded", "succeeded"]);
      // The tracker key is attributed to the configured Jira client.
      expect(records[0]?.tracker).toBe("jira");

      await expectPushedImplementation(run, issue.key);
      await expectPushedImplementation(run, markdownKey);

      // Each invocation saw its own task's prompt, in the documented order.
      expect(recordedPromptMarkers(run)).toEqual([[jiraMarker], [markdownMarker]]);

      // Durable Jira state proves the production client handled the key: the
      // issue transitioned and received the implementation summary comment.
      expect(await tracker.getStatus(issue.key)).toBe(statuses.prStatus);
      assertImplementationComment(await tracker.listComments(issue.key));

      // The decoy never produced a run, a comment, a status change, or a branch.
      expect(records.some((record) => record.task_key === decoy.key)).toBe(false);
      expect(await run.remoteSha(featureBranch(decoy.key))).toBeUndefined();
      expect(await tracker.getStatus(decoy.key)).toBe(statuses.todoStatus);
      expect(await tracker.listComments(decoy.key)).toEqual([]);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "a failed Markdown task in a batch does not stop later tasks or delete earlier branches",
  async () => {
    const run = new FixtureWorkspace();
    const remote = join(run.root, "remote.git");
    const token = batchToken();
    const keys = ["first-good", "failing", "second-good"].map(
      (name) => `e2e-isolation-${name}-${token}`,
    );
    // Alphanumeric only: a tracker description would Markdown-escape `_`.
    const failureMarker = `E2EFAIL${token.toUpperCase()}`;
    const markers = keys.map(() => promptMarker());
    const tasks = keys.map((key, index) =>
      writeMarkdownTask(
        run,
        `isolation-task-${index + 1}`,
        key,
        index === 1
          ? `# Failing batch task\n\nChange the greeting to Hello, world!.\n\n${failureMarker}\n\n${markers[index]}\n`
          : `# Good batch task ${index + 1}\n\nChange the greeting to Hello, world! and run bun test.\n\n${markers[index]}\n`,
      ),
    );
    try {
      await command(["git", "init", "--bare", remote], run.root, run.env);
      await run.prepare(remote, "test-token", {});

      const result = await runBatch(run, tasks, {
        env: { E2E_FAIL_PROMPT_MARKER: failureMarker },
      });

      // The summary is printed before the non-zero exit.
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("Batch Processing Summary");
      expect(result.stdout).toContain("✅ Successful: 2");
      expect(result.stdout).toContain("❌ Failed: 1");

      const records = run.runRecords({ allTasks: true });
      expect(records.map((record) => record.task_key)).toEqual(keys);
      expect(records.map((record) => record.status)).toEqual(["succeeded", "failed", "succeeded"]);

      // The earlier and later tasks published their branches; the failed
      // middle task did not roll back or delete either of them.
      await expectPushedImplementation(run, keys[0]);
      await expectPushedImplementation(run, keys[2]);
      expect(await run.remoteSha(featureBranch(keys[1]))).toBeUndefined();
      expect(recordedPromptMarkers(run)).toEqual(markers.map((marker) => [marker]));
    } finally {
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "a failed Jira task in a mixed batch posts failure feedback and continues with the next task",
  async () => {
    // Same-visible status for in-progress and post-PR because the local bare
    // remote cannot complete the PR. Failure must return the ticket to To Do.
    const tracker = new FakeJiraTracker({ statuses: { pr: "In Progress" } });
    const run = new FixtureWorkspace();
    const remote = join(run.root, "remote.git");
    const token = batchToken();
    const failureMarker = `E2EFAIL${token.toUpperCase()}`;
    const jiraMarker = promptMarker();
    const markdownMarker = promptMarker();
    try {
      const issue = await tracker.createTicket({
        title: "Expand the greeting (failing)",
        body: `# Expand the greeting\n\nChange the greeting to Hello, world!.\n\n${failureMarker}\n\n${jiraMarker}\n`,
      });
      const statuses: Required<TrackerStatusSettings> = {
        todoStatus: tracker.statuses.todo,
        inProgressStatus: tracker.statuses.inProgress,
        prStatus: tracker.statuses.pr,
      };

      await command(["git", "init", "--bare", remote], run.root, run.env);
      await run.prepare(remote, "test-token", tracker.environment());

      // Written after prepare so the pre-branch cleanup cannot remove it.
      const settingsDir = join(run.cwd, ".devintern-code");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.json"),
        `${JSON.stringify(buildTrackerSettings("jira", tracker.projectKey(), statuses), null, 2)}\n`,
      );

      const markdownKey = `e2e-tracker-failure-file-${token}`;
      const markdownTask = writeMarkdownTask(
        run,
        "tracker-failure-next",
        markdownKey,
        `# Expand the greeting after a failed tracker task\n\nChange the greeting to Hello, world! and run bun test.\n\n${markdownMarker}\n`,
      );

      const result = await runBatch(run, [issue.key, markdownTask], {
        skipComments: false,
        env: { E2E_FAIL_PROMPT_MARKER: failureMarker },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("Batch Processing Summary");
      expect(result.stdout).toContain("✅ Successful: 1");
      expect(result.stdout).toContain("❌ Failed: 1");

      const records = run.runRecords({ allTasks: true });
      expect(records.map((record) => record.task_key)).toEqual([issue.key, markdownKey]);
      expect(records.map((record) => record.status)).toEqual(["failed", "succeeded"]);

      // The tracker-specific failure path ran: a durable failure comment was
      // posted and the ticket moved back to To Do so a later run can retry.
      expect(await tracker.getStatus(issue.key)).toBe(statuses.todoStatus);
      assertProcessingFailureComment(await tracker.listComments(issue.key));

      // The next Markdown task still published its branch; the failed Jira
      // task did not leave one behind.
      await expectPushedImplementation(run, markdownKey);
      expect(await run.remoteSha(featureBranch(issue.key))).toBeUndefined();

      // Both tasks' own prompts reached the agent in batch order.
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual([
        "implement",
        "implement",
      ]);
      expect(recordedPromptMarkers(run)).toEqual([[jiraMarker], [markdownMarker]]);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);
