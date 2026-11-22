/**
 * Signed GitLab MR deliveries drive the `webhook serve` review pipeline offline.
 *
 * The built CLI runs `devintern webhook serve` against a loopback GitLab v4
 * stand-in (`FakeGitlabForge`) and a local bare repository. Deliveries are
 * signed with GitLab Standard Webhooks headers. A note on a registered agent MR
 * must spawn `address-review`, run the deterministic agent on the reviewer's
 * feedback, push a commit to the MR branch, and reply to the discussion;
 * merge/close hooks must settle the registry row; and a delivery for an
 * unregistered MR must be acknowledged without touching the agent or forge.
 *
 * Unlike `webhook-serve.test.ts`, the review queue is not paused: these
 * deliveries really reach the pipeline, and the fake forge and bare remote are
 * the only things it can reach.
 */

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { isolatedEnvironment } from "../../helpers/environment";
import { FakeGitlabForge } from "../../helpers/fake-gitlab-forge";
import { cliPath } from "../../helpers/fixture-workspace";
import { checkedCommand } from "../../helpers/process";
import { WebhookServerFixture } from "../../helpers/webhook-server";

const cliTest = test.skipIf(!existsSync(cliPath));

const packageRoot = resolve(import.meta.dir, "../..");
const PROJECT_ID = 1;
const PROJECT_PATH = "fixture/repo";
const BASE_BRANCH = "e2e-base";
const AGENT_BRANCH = "devintern/e2e-1-greeting";
const SECOND_BRANCH = "devintern/e2e-2-farewell";
const UNREGISTERED_IID = 9;
const WAIT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 100;
const DELIVERY_SOURCE = "gitlab:webhook";

interface WebhookResponse {
  success?: boolean;
  message?: string;
  error?: string;
  matchedMergeRequests?: number;
  eventIds?: string[];
}

interface AgentInvocation {
  mode: string;
  promptMarkers?: string[];
}

interface AgentPrRow {
  change_number: number;
  state: string;
  close_reason: string | null;
  merged_at: number | null;
  host_merged_at: number | null;
  merged_into: string | null;
}

interface Scenario {
  root: string;
  remote: string;
  seed: string;
  gitBin: string;
  forge: FakeGitlabForge;
  server: WebhookServerFixture;
  codeHostToken: string;
  signingToken: string;
  invocationsPath: string;
}

/** Everything a test created, torn down by `afterEach` even after a failure. */
const owned: { forge?: FakeGitlabForge; server?: WebhookServerFixture; root?: string } = {};

afterEach(async () => {
  const leftovers: string[] = [];
  try {
    owned.forge?.stop();
  } catch (error) {
    leftovers.push(`fake forge: ${String(error)}`);
  }
  try {
    await owned.server?.dispose();
  } catch (error) {
    leftovers.push(`webhook server: ${String(error)}`);
  }
  if (owned.root) {
    rmSync(owned.root, { recursive: true, force: true });
    if (existsSync(owned.root)) leftovers.push(`temp root ${owned.root}`);
  }
  owned.forge = undefined;
  owned.server = undefined;
  owned.root = undefined;
  if (leftovers.length > 0) {
    throw new Error(`could not clean up: ${leftovers.join("; ")}`);
  }
});

/** Quote a string for a POSIX single-quoted shell literal. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Put a `git` wrapper first on PATH and rewrite the forge URL onto the bare repo.
 *
 * The checkout's origin is the forge's HTTP URL (address-review refuses an
 * origin that is not the MR's GitLab project), while `url.<bare>.insteadOf`
 * sends fetch and push to the local bare repository. `git remote get-url`
 * applies `insteadOf` too, so the wrapper drops the rewrite for that one call.
 * Same technique as `worker-conflict-failover.test.ts`.
 */
function gitRewriteEnv(
  root: string,
  gitBin: string,
  remote: string,
  httpUrl: string,
  basePath: string,
): Record<string, string> {
  const dir = join(root, "git-bin");
  mkdirSync(dir, { recursive: true });
  const wrapper = join(dir, "git");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      "prev=",
      "strip=0",
      'for arg in "$@"; do',
      '  if [ "$prev" = "remote" ] && [ "$arg" = "get-url" ]; then strip=1; fi',
      "  prev=$arg",
      "done",
      'if [ "$strip" = 1 ]; then',
      "  unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 \\",
      "    GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1 GIT_CONFIG_KEY_2 GIT_CONFIG_VALUE_2 \\",
      "    GIT_CONFIG_KEY_3 GIT_CONFIG_VALUE_3",
      "fi",
      `exec ${shQuote(gitBin)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(wrapper, 0o700);
  return {
    PATH: `${dir}${delimiter}${basePath}`,
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_CONFIG_KEY_3: `url.${remote}.insteadOf`,
    GIT_CONFIG_VALUE_3: httpUrl,
  };
}

function revParse(gitBin: string, gitDir: string, branch: string): string {
  const result = spawnSync(gitBin, ["--git-dir", gitDir, "rev-parse", `refs/heads/${branch}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git rev-parse failed for ${branch}: ${result.stderr}`);
  return result.stdout.trim();
}

function showFile(gitBin: string, gitDir: string, branch: string, path: string): string {
  const result = spawnSync(gitBin, ["--git-dir", gitDir, "show", `refs/heads/${branch}:${path}`], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout : "";
}

/** Seed a bare remote with the base branch and two agent branches. */
async function seedRepository(
  root: string,
  env: Record<string, string>,
): Promise<{ remote: string; seed: string }> {
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  cpSync(join(packageRoot, "fixtures/simple-project"), seed, { recursive: true });
  await checkedCommand(
    ["git", "init", "--bare", "--initial-branch", BASE_BRANCH, remote],
    root,
    env,
  );
  const git = (...args: string[]) => checkedCommand(["git", ...args], seed, env);
  await git("init", "--initial-branch", BASE_BRANCH);
  await git("remote", "add", "origin", remote);
  await git("add", ".");
  await git("commit", "-m", "Seed webhook fixture");
  await git("push", "--set-upstream", "origin", BASE_BRANCH);
  // The agent branch already holds the implementation the reviewer comments
  // on; the deterministic agent's review mode refuses any other content.
  await git("checkout", "-b", AGENT_BRANCH);
  writeFileSync(join(seed, "src/greeting.ts"), 'export const greeting = "Hello, world!";\n');
  await git("commit", "-am", "Implement greeting");
  await git("push", "origin", AGENT_BRANCH);
  await git("checkout", "-b", SECOND_BRANCH, BASE_BRANCH);
  await git("commit", "--allow-empty", "-m", "Second agent change");
  await git("push", "origin", SECOND_BRANCH);
  await git("checkout", BASE_BRANCH);
  return { remote, seed };
}

/**
 * Seed the repository, start the forge, and start `webhook serve` with the
 * review queue live. All state lives under one temporary root.
 */
async function openScenario(review?: { body: string }): Promise<Scenario> {
  const gitBin = Bun.which("git");
  if (!gitBin) throw new Error("git is required for the webhook review fixture");
  const root = mkdtempSync(join(tmpdir(), "devintern-e2e-webhook-gitlab-"));
  owned.root = root;
  const baseEnv = isolatedEnvironment(root);
  const { remote, seed } = await seedRepository(root, baseEnv);

  const codeHostToken = `glpat-e2e-${randomBytes(16).toString("hex")}`;
  const signingToken = `whsec_${randomBytes(32).toString("base64")}`;
  const forge = new FakeGitlabForge({
    gitDir: remote,
    gitBin,
    sourceBranch: AGENT_BRANCH,
    targetBranch: BASE_BRANCH,
    token: codeHostToken,
    ...(review
      ? {
          review: {
            discussionId: randomBytes(20).toString("hex"),
            noteId: 501,
            body: review.body,
            reviewer: "e2e-reviewer",
          },
        }
      : {}),
  });
  owned.forge = forge;

  const httpUrl = `${forge.baseUrl}/${PROJECT_PATH}.git`;
  await checkedCommand(["git", "remote", "set-url", "origin", httpUrl], seed, baseEnv);

  const agent = join(root, "agent.ts");
  cpSync(join(packageRoot, "helpers/fake-agent.ts"), agent);
  chmodSync(agent, 0o700);
  const invocationsPath = join(root, "agent-invocations.jsonl");

  const env: Record<string, string> = {
    ...gitRewriteEnv(root, gitBin, remote, httpUrl, baseEnv.PATH ?? ""),
    AGENT_CLI_PATH: agent,
    E2E_AGENT_INVOCATIONS: invocationsPath,
    DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
    GITLAB_CODE_HOST_URL: forge.baseUrl,
    GITLAB_CODE_HOST_TOKEN: codeHostToken,
    DEVINTERN_REVIEW_WORKTREE_PATH: join(root, "review-worktree"),
  };
  const server = await WebhookServerFixture.start({
    root,
    env,
    cwd: seed,
    gitlabWebhookSigningToken: signingToken,
  });
  owned.server = server;
  return {
    root,
    remote,
    seed,
    gitBin,
    forge,
    server,
    codeHostToken,
    signingToken,
    invocationsPath,
  };
}

/** POST a GitLab delivery with valid Standard Webhooks headers. */
async function deliver(
  scenario: Scenario,
  event: "Note Hook" | "Merge Request Hook",
  payload: unknown,
  webhookId: string = randomUUID(),
): Promise<{ status: number; body: WebhookResponse; webhookId: string }> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const secret = Buffer.from(scenario.signingToken.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", secret)
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest("base64");
  const response = await fetch(`${scenario.server.baseUrl}/webhooks/gitlab`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-event": event,
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
    body,
  });
  return { status: response.status, body: (await response.json()) as WebhookResponse, webhookId };
}

function project(baseUrl: string): Record<string, unknown> {
  return {
    id: PROJECT_ID,
    name: "repo",
    path_with_namespace: PROJECT_PATH,
    web_url: `${baseUrl}/${PROJECT_PATH}`,
  };
}

/** `Note Hook` for a comment on an MR, shaped like GitLab's payload. */
function noteHook(baseUrl: string, iid: number, note: string): Record<string, unknown> {
  return {
    object_kind: "note",
    event_type: "note",
    user: { id: 42, username: "e2e-reviewer", name: "E2E Reviewer" },
    project_id: PROJECT_ID,
    project: project(baseUrl),
    object_attributes: {
      id: 501,
      note,
      noteable_type: "MergeRequest",
      noteable_id: 1000 + iid,
      discussion_id: randomBytes(20).toString("hex"),
      system: false,
      url: `${baseUrl}/${PROJECT_PATH}/-/merge_requests/${iid}#note_501`,
    },
    merge_request: {
      iid,
      state: "opened",
      source_branch: AGENT_BRANCH,
      target_branch: BASE_BRANCH,
    },
  };
}

/** `Merge Request Hook` for a merge or close action. */
function mergeRequestHook(
  baseUrl: string,
  iid: number,
  branch: string,
  action: "merge" | "close",
  mergedAt?: string,
): Record<string, unknown> {
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    user: { id: 42, username: "e2e-reviewer", name: "E2E Reviewer" },
    project: project(baseUrl),
    object_attributes: {
      iid,
      action,
      state: action === "merge" ? "merged" : "closed",
      source_branch: branch,
      target_branch: BASE_BRANCH,
      source_project_id: PROJECT_ID,
      target_project_id: PROJECT_ID,
      ...(mergedAt ? { merged_at: mergedAt } : {}),
      url: `${baseUrl}/${PROJECT_PATH}/-/merge_requests/${iid}`,
    },
  };
}

/** Register an agent MR the way the worker pipeline records one it opened. */
function registerMergeRequest(scenario: Scenario, iid: number, branch: string): void {
  const db = new Database(scenario.server.queueDbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const now = Date.now();
    db.run(
      `INSERT INTO agent_prs (
         provider, instance_url, project_id, project_path, change_number, web_url,
         repo, pr_number, branch, state, created_at, updated_at
       ) VALUES ('gitlab', ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      [
        scenario.forge.baseUrl,
        String(PROJECT_ID),
        PROJECT_PATH,
        iid,
        `${scenario.forge.baseUrl}/${PROJECT_PATH}/-/merge_requests/${iid}`,
        PROJECT_PATH,
        iid,
        branch,
        now,
        now,
      ],
    );
  } finally {
    db.close();
  }
}

function agentPrRows(dbPath: string): AgentPrRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    return db
      .query(
        `SELECT change_number, state, close_reason, merged_at, host_merged_at, merged_into
         FROM agent_prs ORDER BY change_number`,
      )
      .all() as AgentPrRow[];
  } finally {
    db.close();
  }
}

function deliverySettled(dbPath: string, webhookId: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const row = db
      .query("SELECT 1 FROM processed_events WHERE source = ? AND external_id = ?")
      .get(DELIVERY_SOURCE, `webhook-id:${webhookId}`);
    return row !== null;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function webhookEventStatuses(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.query("SELECT status FROM webhook_events ORDER BY created_at").all() as Array<{
        status: string;
      }>
    ).map((row) => row.status);
  } finally {
    db.close();
  }
}

function agentInvocations(path: string): AgentInvocation[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentInvocation);
}

/** Server output with both token forms removed, bounded for failure messages. */
function diagnostics(scenario: Scenario): string {
  let text = `stdout:\n${scenario.server.stdout}\nstderr:\n${scenario.server.stderr}`;
  for (const secret of [scenario.codeHostToken, scenario.signingToken]) {
    text = text.split(secret).join("[redacted]");
    text = text.split(encodeURIComponent(secret)).join("[redacted]");
  }
  const lines = text.split("\n");
  return [
    ...lines.slice(-120),
    `forge requests: ${JSON.stringify(scenario.forge.requests)}`,
    `forge unexpected: ${JSON.stringify(scenario.forge.unexpected)}`,
  ].join("\n");
}

async function waitFor(
  scenario: Scenario,
  label: string,
  condition: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for ${label}\n${diagnostics(scenario)}`);
}

function expectNoSecretsInOutput(scenario: Scenario): void {
  const output = `${scenario.server.stdout}\n${scenario.server.stderr}`;
  for (const secret of [scenario.codeHostToken, scenario.signingToken]) {
    expect(output.includes(secret)).toBe(false);
    expect(output.includes(encodeURIComponent(secret))).toBe(false);
  }
}

/**
 * A valid note for an MR that is not in the registry is acknowledged and
 * settled without an agent run or any forge request. It is also the first
 * delivery that opens the worker state, which creates the `agent_prs` table.
 */
async function expectUnregisteredNoteIgnored(scenario: Scenario): Promise<void> {
  const forgeBefore = scenario.forge.requests.length;
  const unmatched = await deliver(
    scenario,
    "Note Hook",
    noteHook(scenario.forge.baseUrl, UNREGISTERED_IID, "Please also handle this."),
  );
  expect(unmatched.status, diagnostics(scenario)).toBe(200);
  expect(unmatched.body.message).toBe("No registered GitLab MR matched");
  expect(unmatched.body.matchedMergeRequests).toBeUndefined();
  expect(deliverySettled(scenario.server.queueDbPath, unmatched.webhookId)).toBe(true);
  expect(scenario.forge.requests.length).toBe(forgeBefore);
  expect(agentInvocations(scenario.invocationsPath)).toEqual([]);
}

cliTest(
  "signed GitLab MR note on a registered agent MR runs address-review and replies",
  async () => {
    const marker = `E2EPROMPTMARKER${randomBytes(6).toString("hex").toUpperCase()}`;
    const scenario = await openScenario({
      body: `Please greet the reviewer instead of the world. E2E_REVIEW_GREETING ${marker}`,
    });
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    const headBefore = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);

    // The delivery's own note text carries no marker: the agent can only see
    // it by fetching the MR discussions from the forge.
    const notePayload = noteHook(scenario.forge.baseUrl, 1, "Please greet the reviewer.");
    const accepted = await deliver(scenario, "Note Hook", notePayload);
    expect(accepted.status, diagnostics(scenario)).toBe(200);
    expect(accepted.body.message).toBe("GitLab event processing started");
    expect(accepted.body.matchedMergeRequests).toBe(1);

    await waitFor(scenario, "the delivery to settle", () =>
      deliverySettled(scenario.server.queueDbPath, accepted.webhookId),
    );

    // The deterministic agent ran once, in review mode, on a prompt that
    // carried the reviewer's discussion note fetched from the forge.
    const invocations = agentInvocations(scenario.invocationsPath);
    expect(invocations, diagnostics(scenario)).toHaveLength(1);
    expect(invocations[0]?.mode).toBe("review");
    expect(invocations[0]?.promptMarkers).toEqual([marker]);

    // A new commit with the review edit landed on the MR branch.
    const headAfter = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    expect(headAfter).not.toBe(headBefore);
    expect(showFile(scenario.gitBin, scenario.remote, AGENT_BRANCH, "src/greeting.ts")).toBe(
      'export const greeting = "Hello, reviewer!";\n',
    );

    // The run replied to the discussion (and wrote nothing else).
    expect(scenario.forge.discussionReplies, diagnostics(scenario)).toHaveLength(1);
    expect(scenario.forge.discussionReplies[0]?.body).toContain(
      "Addressed this feedback in the latest commit.",
    );
    expect(scenario.forge.mutations()).toEqual([
      {
        method: "POST",
        path: expect.stringMatching(
          /^\/api\/v4\/projects\/1\/merge_requests\/1\/discussions\/[^/]+\/notes$/,
        ),
      },
    ]);
    expect(scenario.forge.notes).toEqual([]);
    expect(scenario.forge.unexpected).toEqual([]);
    expect(scenario.forge.authFailures).toEqual([]);
    expect(webhookEventStatuses(scenario.server.queueDbPath)).not.toContain("failed");

    // The settled delivery is deduplicated: a replay never runs the agent again.
    const forgeBefore = scenario.forge.requests.length;
    const replay = await deliver(scenario, "Note Hook", notePayload, accepted.webhookId);
    expect(replay.status).toBe(200);
    expect(replay.body.message).toBe("Duplicate delivery");
    expect(agentInvocations(scenario.invocationsPath)).toHaveLength(1);
    expect(scenario.forge.requests.length).toBe(forgeBefore);
    expect(revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH)).toBe(headAfter);

    expectNoSecretsInOutput(scenario);
  },
  180_000,
);

cliTest(
  "signed GitLab merge/close hooks settle registered MRs; unregistered MRs are ignored",
  async () => {
    const scenario = await openScenario();
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    registerMergeRequest(scenario, 2, SECOND_BRANCH);

    // With registered rows present, an unregistered iid still matches nothing.
    await expectUnregisteredNoteIgnored(scenario);

    const mergedAt = "2026-11-20T12:00:00.000Z";
    const merged = await deliver(
      scenario,
      "Merge Request Hook",
      mergeRequestHook(scenario.forge.baseUrl, 1, AGENT_BRANCH, "merge", mergedAt),
    );
    expect(merged.status, diagnostics(scenario)).toBe(200);
    expect(merged.body.matchedMergeRequests).toBe(1);

    const closed = await deliver(
      scenario,
      "Merge Request Hook",
      mergeRequestHook(scenario.forge.baseUrl, 2, SECOND_BRANCH, "close"),
    );
    expect(closed.status, diagnostics(scenario)).toBe(200);
    expect(closed.body.matchedMergeRequests).toBe(1);

    await waitFor(
      scenario,
      "both lifecycle deliveries to settle",
      () =>
        deliverySettled(scenario.server.queueDbPath, merged.webhookId) &&
        deliverySettled(scenario.server.queueDbPath, closed.webhookId),
    );

    const rows = agentPrRows(scenario.server.queueDbPath);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      change_number: 1,
      state: "closed",
      close_reason: "merged",
      host_merged_at: Date.parse(mergedAt),
      merged_into: BASE_BRANCH,
    });
    expect(rows[0]?.merged_at).not.toBeNull();
    expect(rows[1]).toMatchObject({
      change_number: 2,
      state: "closed",
      close_reason: "closed",
      merged_at: null,
      host_merged_at: null,
      merged_into: null,
    });

    // Lifecycle handling is local bookkeeping: no agent run, no forge call.
    expect(agentInvocations(scenario.invocationsPath)).toEqual([]);
    expect(scenario.forge.requests).toEqual([]);
    expect(webhookEventStatuses(scenario.server.queueDbPath)).not.toContain("failed");

    // A merged MR is no longer open, so a later note for it matches nothing.
    const late = await deliver(
      scenario,
      "Note Hook",
      noteHook(scenario.forge.baseUrl, 1, "One more thing after merge."),
    );
    expect(late.status).toBe(200);
    expect(late.body.message).toBe("No registered GitLab MR matched");
    expect(agentInvocations(scenario.invocationsPath)).toEqual([]);
    expect(scenario.forge.requests).toEqual([]);

    expectNoSecretsInOutput(scenario);
  },
  120_000,
);
