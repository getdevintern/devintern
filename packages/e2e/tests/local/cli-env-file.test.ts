import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { command, checkedCommand } from "../../helpers/process";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import { buildTrackerSettings, TRACKER_UNRELATED_LABEL } from "../../helpers/tracker-scenario";
import type { TrackerStatusSettings } from "../../helpers/tracker-scenario";
import type { TrackerTicket } from "../../providers/tracker";
import { FakeJiraTracker } from "../../providers/fake-jira";

interface JiraSeed {
  issue: TrackerTicket;
  decoy: TrackerTicket;
  descriptionMarker: string;
  commentMarker: string;
  decoyMarker: string;
}

/** A closed port that fails immediately without touching the network. */
const UNREACHABLE_JIRA_URL = "http://127.0.0.1:1";

/**
 * Seed the expected issue and a decoy outside the selector.
 *
 * The ticket body and comment markers are unique so the deterministic agent
 * fixture can prove both reached its input through the tracker HTTP API.
 */
async function seedJiraScenario(tracker: FakeJiraTracker): Promise<JiraSeed> {
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

/** Write the per-project Jira statuses the CLI looks up during the run. */
function writeJiraSettings(
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

/** Render a set of values in dotenv format. */
const envLines = (values: Record<string, string>): string =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

/** Write a credential file in dotenv format. */
function writeEnvFile(path: string, values: Record<string, string>): void {
  writeFileSync(path, `${envLines(values)}\n`);
}

/** Write a project `.devintern-code/.env` pointing Jira at a closed port. */
function writeUnreachableProjectEnv(run: FixtureWorkspace, projectKey: string): void {
  const configDir = join(run.cwd, ".devintern-code");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, ".env"),
    `${envLines({
      TASK_TRACKER: "jira",
      JIRA_BASE_URL: UNREACHABLE_JIRA_URL,
      JIRA_EMAIL: "project@example.invalid",
      JIRA_API_TOKEN: "project-wrong-token",
      JIRA_DEFAULT_PROJECT_KEY: projectKey,
    })}\n`,
  );
}

/** Initialize the isolated local bare remote and prepare the CLI workspace. */
async function prepareJiraWorkspace(
  run: FixtureWorkspace,
  tracker: FakeJiraTracker,
  seed: JiraSeed,
  statuses: Required<TrackerStatusSettings>,
): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  // Tracker credentials deliberately stay out of the subprocess environment;
  // only the markers the deterministic agent asserts on are inherited.
  await run.prepare(remote, "test-token", {
    E2E_EXPECT_DESCRIPTION_MARKER: seed.descriptionMarker,
    E2E_EXPECT_COMMENT_MARKER: seed.commentMarker,
  });
  writeJiraSettings(run, tracker.projectKey(), statuses);
}

/**
 * Build the CLI environment.
 *
 * Ambient tracker credentials are removed so every credential must come from
 * the selected env file. `TASK_TRACKER` is optionally kept set to a conflicting
 * tracker to prove an explicit `--env-file` wins over ambient configuration.
 */
function cliEnvironment(
  run: FixtureWorkspace,
  options: { ambientTaskTracker?: string } = {},
): Record<string, string> {
  const env: Record<string, string> = { ...run.env, DEVINTERN_FETCH_MAX_RETRIES: "0" };
  delete env.TASK_TRACKER;
  if (options.ambientTaskTracker) env.TASK_TRACKER = options.ambientTaskTracker;
  return env;
}

/** Run the built CLI against a Jira issue key with the shared fixture flags. */
function runJiraTask(
  run: FixtureWorkspace,
  taskKey: string,
  options: {
    extraArgs?: string[];
    ambientTaskTracker?: string;
  } = {},
) {
  return command(
    [
      process.execPath,
      cliPath,
      taskKey,
      "--agent-path",
      join(run.root, "bin/agent.ts"),
      "--skip-clarity-check",
      "--skip-comments",
      "--create-pr",
      "--pr-target-branch",
      run.base,
      "--hook-retries",
      "0",
      "--no-update",
      ...(options.extraArgs ?? []),
    ],
    run.cwd,
    {
      ...cliEnvironment(run, { ambientTaskTracker: options.ambientTaskTracker }),
      E2E_AGENT_MODE: "implement",
    },
  );
}

/** Run records, or none when the CLI exited before creating the queue database. */
function readRunRecords(run: FixtureWorkspace) {
  return existsSync(run.env.WEBHOOK_QUEUE_DB) ? run.runRecords({ allTasks: true }) : [];
}

/** Assert the CLI never started a task: no branch, run record, or agent call. */
async function assertNoTaskStarted(run: FixtureWorkspace, key: string): Promise<void> {
  expect(await run.git("branch", "--show-current")).toBe(run.base);
  expect(await run.remoteSha(`feature/${key.toLowerCase()}`)).toBeUndefined();
  expect(readRunRecords(run)).toEqual([]);
  expect(run.agentInvocations()).toEqual([]);
}

/** Assert the run implemented only the selected ticket through the fake Jira. */
async function assertImplemented(
  run: FixtureWorkspace,
  tracker: FakeJiraTracker,
  seed: JiraSeed,
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

  // Exactly the selected ticket produced a run attributed to the file's tracker.
  const records = readRunRecords(run);
  expect(records).toHaveLength(1);
  expect(records[0]?.status).toBe("succeeded");
  expect(records[0]?.tracker).toBe("jira");
  expect(records[0]?.task_key).toBe(key);
  expect(records[0]?.pr_url).toBeNull();
  expect(records.some((record) => record.task_key === seed.decoy.key)).toBe(false);
  expect(await run.remoteSha(`feature/${seed.decoy.key.toLowerCase()}`)).toBeUndefined();
  expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["implement"]);

  // The fake served the run, and both seeded markers reached the agent input.
  expect(tracker.requestCount).toBeGreaterThan(0);

  // `--skip-comments` suppresses tracker writes, so the selected ticket and the
  // decoy keep their seeded state; reading it back also proves the seeded
  // description came from the fake and not from anywhere else.
  const ticket = await tracker.getTicket(key);
  expect(ticket.body).toContain(seed.descriptionMarker);
  expect(await tracker.getStatus(key)).toBe(tracker.statuses.todo);
  expect(await tracker.listComments(key)).toHaveLength(1);

  const decoy = await tracker.getTicket(seed.decoy.key);
  expect(decoy.body).toContain(seed.decoyMarker);
  expect(decoy.body).not.toContain(seed.descriptionMarker);
  expect(await tracker.getStatus(seed.decoy.key)).toBe(tracker.statuses.todo);
  expect(await tracker.listComments(seed.decoy.key)).toEqual([]);

  expect(tracker.unexpectedRequests).toEqual([]);
}

const statusesFor = (tracker: FakeJiraTracker): Required<TrackerStatusSettings> => ({
  todoStatus: tracker.statuses.todo,
  inProgressStatus: tracker.statuses.inProgress,
  prStatus: tracker.statuses.pr,
});

/**
 * The offline lifecycle uses one actioned workflow status for both the
 * in-progress and post-PR settings, because a local bare remote cannot create
 * the PR that would trigger a second transition.
 */
const createOfflineJira = (): FakeJiraTracker =>
  new FakeJiraTracker({ statuses: { pr: "In Progress" } });

test.skipIf(!existsSync(cliPath))(
  "built CLI uses --env-file credentials ahead of the project .env",
  async () => {
    const tracker = createOfflineJira();
    const run = new FixtureWorkspace();
    try {
      const seed = await seedJiraScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareJiraWorkspace(run, tracker, seed, statuses);
      writeUnreachableProjectEnv(run, tracker.projectKey());

      const customEnv = join(run.root, "custom-jira.env");
      writeEnvFile(customEnv, tracker.environment());

      // Keep the allowlisted ambient TASK_TRACKER (markdown) in place: the
      // explicit file must supply the real tracker along with every credential.
      const result = await runJiraTask(run, seed.issue.key, {
        extraArgs: ["--env-file", customEnv],
        ambientTaskTracker: "markdown",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Loaded environment from custom file");
      await assertImplemented(run, tracker, seed);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "keys absent from --env-file are not filled from the project .env",
  async () => {
    const tracker = createOfflineJira();
    const run = new FixtureWorkspace();
    try {
      const seed = await seedJiraScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareJiraWorkspace(run, tracker, seed, statuses);
      // The project file names an unreachable host and carries its own token.
      writeUnreachableProjectEnv(run, tracker.projectKey());

      // The explicit file supplies only a token. If the project file leaked in,
      // the CLI would pair its JIRA_BASE_URL/JIRA_EMAIL with this token and send
      // a request to the project-controlled host.
      const customEnv = join(run.root, "token-only.env");
      writeEnvFile(customEnv, { JIRA_API_TOKEN: tracker.environment().JIRA_API_TOKEN });

      const result = await runJiraTask(run, seed.issue.key, {
        extraArgs: ["--env-file", customEnv],
      });

      expect(result.exitCode).not.toBe(0);
      // Validation fails for the omitted keys instead of silently borrowing
      // them from .devintern-code/.env.
      expect(result.stderr).toContain("Missing required JIRA environment variables");
      expect(result.stderr).toContain("JIRA_BASE_URL");
      expect(result.stderr).toContain("JIRA_EMAIL");

      // Neither the fake nor the project host was contacted.
      expect(tracker.requestCount).toBe(0);
      expect(result.stdout).not.toContain(`Fetching task: ${seed.issue.key}`);
      await assertNoTaskStarted(run, seed.issue.key);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI falls back to the project .env when --env-file is omitted",
  async () => {
    const tracker = createOfflineJira();
    const run = new FixtureWorkspace();
    try {
      const seed = await seedJiraScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareJiraWorkspace(run, tracker, seed, statuses);
      writeUnreachableProjectEnv(run, tracker.projectKey());

      const result = await runJiraTask(run, seed.issue.key);
      expect(result.exitCode).not.toBe(0);

      // The project file was actually read: credential validation passed and
      // the CLI reached the task fetch instead of reporting missing variables.
      expect(result.stdout).toContain(`Fetching task: ${seed.issue.key}`);
      expect(result.stderr).not.toContain("Missing required Jira environment variables");

      // Nothing reached the fake, and no task attempt was recorded.
      expect(tracker.requestCount).toBe(0);
      await assertNoTaskStarted(run, seed.issue.key);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "a missing --env-file path exits before any agent or tracker work",
  async () => {
    const tracker = createOfflineJira();
    const run = new FixtureWorkspace();
    try {
      const seed = await seedJiraScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareJiraWorkspace(run, tracker, seed, statuses);
      // A valid project file must not mask the missing explicit path.
      writeUnreachableProjectEnv(run, tracker.projectKey());

      const missingEnv = join(run.root, "does-not-exist.env");
      const result = await runJiraTask(run, seed.issue.key, {
        extraArgs: ["--env-file", missingEnv],
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Specified .env file not found");
      expect(result.stderr).toContain(missingEnv);

      expect(tracker.requestCount).toBe(0);
      await assertNoTaskStarted(run, seed.issue.key);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI runs from --env-file credentials when no project .env exists",
  async () => {
    const tracker = createOfflineJira();
    const run = new FixtureWorkspace();
    try {
      const seed = await seedJiraScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareJiraWorkspace(run, tracker, seed, statuses);
      expect(existsSync(join(run.cwd, ".devintern-code", ".env"))).toBe(false);

      const customEnv = join(run.root, "custom-only.env");
      writeEnvFile(customEnv, tracker.environment());

      const result = await runJiraTask(run, seed.issue.key, {
        extraArgs: ["--env-file", customEnv],
      });
      expect(result.exitCode).toBe(0);
      await assertImplemented(run, tracker, seed);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);
