/**
 * Shared offline scenario for `devintern webhook serve` GitLab deliveries.
 *
 * Seeds a local bare repository, starts a loopback `FakeGitlabForge`, and runs
 * the built CLI's `webhook serve` with the review queue live and the
 * deterministic `fake-agent.ts` as the agent. Deliveries are authenticated
 * either with GitLab Standard Webhooks signatures or with the legacy
 * `X-Gitlab-Token` shared secret. {@link openStandaloneScenario} seeds the same
 * repository and forge without the server, for running `address-review` and
 * `resolve-conflicts` directly. Everything lives under one temporary root,
 * owned by a {@link ScenarioOwner} that the test file tears down in
 * `afterEach`.
 */

import { expect } from "bun:test";
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
import { isolatedEnvironment } from "./environment";
import { FakeGitlabForge } from "./fake-gitlab-forge";
import type { FakeGitlabCiFailure } from "./fake-gitlab-forge";
import { cliPath } from "./fixture-workspace";
import { checkedCommand, command } from "./process";
import type { CommandResult } from "./process";
import { WebhookServerFixture, ensureQueueDb } from "./webhook-server";

const packageRoot = resolve(import.meta.dir, "..");
export const PROJECT_ID = 1;
export const PROJECT_PATH = "fixture/repo";
export const BASE_BRANCH = "e2e-base";
export const AGENT_BRANCH = "devintern/e2e-1-greeting";
export const SECOND_BRANCH = "devintern/e2e-2-farewell";
export const UNREGISTERED_IID = 9;
/** Target-branch greeting that conflicts with the agent branch's `Hello, world!`. */
export const BASE_CONFLICT_GREETING = 'export const greeting = "Hello, base!";\n';
/** File only the target branch adds in the `behind` seed. */
export const BASE_ONLY_FILE = "BASE_NOTE.md";
const WAIT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 100;
const DELIVERY_SOURCE = "gitlab:webhook";

export type GitLabEventName = "Note Hook" | "Merge Request Hook" | "Pipeline Hook" | "Job Hook";

export interface WebhookResponse {
  success?: boolean;
  message?: string;
  error?: string;
  matchedMergeRequests?: number;
  eventIds?: string[];
}

export interface AgentInvocation {
  mode: string;
  promptMarkers?: string[];
}

export interface AgentPrRow {
  change_number: number;
  state: string;
  close_reason: string | null;
  merged_at: number | null;
  host_merged_at: number | null;
  merged_into: string | null;
}

export interface Scenario {
  root: string;
  remote: string;
  seed: string;
  gitBin: string;
  forge: FakeGitlabForge;
  server: WebhookServerFixture;
  codeHostToken: string;
  /** Standard Webhooks signing token (`whsec_…`), set in signature and both modes. */
  signingToken?: string;
  /** `X-Gitlab-Token` shared secret, set in token and both modes. */
  sharedToken?: string;
  invocationsPath: string;
}

export interface ScenarioOptions {
  /** Serve one unresolved reviewer discussion with this body (address-review path). */
  review?: { body: string };
  /**
   * Serve one failed pipeline/job for the agent branch's seeded head. The SHA
   * is filled in from the seeded repository.
   */
  ci?: Omit<FakeGitlabCiFailure, "sha">;
  /**
   * Move the target branch after the agent branch forked: `conflict` edits
   * the agent branch's line, `behind` adds an unrelated file (clean merge).
   */
  baseChange?: "conflict" | "behind";
  /**
   * `signature` (default): `GITLAB_WEBHOOK_SIGNING_TOKEN`. `token`:
   * `GITLAB_WEBHOOK_SECRET`. `both`: both secrets at once; default deliveries
   * are then signed.
   */
  auth?: "signature" | "token" | "both";
}

/** Everything a test created, torn down by {@link cleanupScenario} even after a failure. */
export interface ScenarioOwner {
  forge?: FakeGitlabForge;
  server?: WebhookServerFixture;
  root?: string;
}

/** Stop the forge and server and remove the root; throw listing anything left behind. */
export async function cleanupScenario(owned: ScenarioOwner): Promise<void> {
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
    try {
      rmSync(owned.root, { recursive: true, force: true });
    } catch (error) {
      leftovers.push(`temp root ${owned.root}: ${String(error)}`);
    }
    if (existsSync(owned.root)) leftovers.push(`temp root ${owned.root}`);
  }
  owned.forge = undefined;
  owned.server = undefined;
  owned.root = undefined;
  if (leftovers.length > 0) {
    throw new Error(`could not clean up: ${leftovers.join("; ")}`);
  }
}

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

export function revParse(gitBin: string, gitDir: string, branch: string): string {
  const result = spawnSync(gitBin, ["--git-dir", gitDir, "rev-parse", `refs/heads/${branch}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git rev-parse failed for ${branch}: ${result.stderr}`);
  return result.stdout.trim();
}

export function showFile(gitBin: string, gitDir: string, branch: string, path: string): string {
  const result = spawnSync(gitBin, ["--git-dir", gitDir, "show", `refs/heads/${branch}:${path}`], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout : "";
}

/** Parent SHAs of a commit in the bare remote, in order. */
export function commitParents(gitBin: string, gitDir: string, sha: string): string[] {
  const result = spawnSync(gitBin, ["--git-dir", gitDir, "rev-list", "--parents", "-n", "1", sha], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git rev-list failed for ${sha}: ${result.stderr}`);
  return result.stdout.trim().split(/\s+/).slice(1);
}

/** `true` when `ancestor` is reachable from `descendant` (a fast-forward, not a rewrite). */
export function isAncestor(
  gitBin: string,
  gitDir: string,
  ancestor: string,
  descendant: string,
): boolean {
  const result = spawnSync(
    gitBin,
    ["--git-dir", gitDir, "merge-base", "--is-ancestor", ancestor, descendant],
    { encoding: "utf8" },
  );
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git merge-base --is-ancestor failed: ${result.stderr}`);
  }
  return result.status === 0;
}

/**
 * Push one commit adding `path` on top of the agent branch, through a
 * throwaway clone of the bare remote, so the MR head the fake forge reports
 * moves on. Leaves `src/greeting.ts` alone, so conflict and CI-repair runs
 * still apply to the new head. Returns the new head SHA.
 */
export async function advanceAgentBranch(
  scenario: Pick<Scenario, "root" | "remote" | "gitBin">,
  path: string,
): Promise<string> {
  const env = isolatedEnvironment(scenario.root);
  const clone = mkdtempSync(join(scenario.root, "advance-"));
  try {
    await checkedCommand(
      [scenario.gitBin, "clone", "--quiet", "--branch", AGENT_BRANCH, scenario.remote, clone],
      scenario.root,
      env,
    );
    writeFileSync(join(clone, path), `Advanced head: ${path}\n`);
    const git = (...args: string[]) => checkedCommand([scenario.gitBin, ...args], clone, env);
    await git("add", path);
    await git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", `Advance ${path}`);
    await git("push", "--quiet", "origin", AGENT_BRANCH);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
  return revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
}

/** `true` when `head` merges into `base` without conflicts. */
export function mergesCleanly(gitBin: string, gitDir: string, base: string, head: string): boolean {
  const result = spawnSync(
    gitBin,
    ["--git-dir", gitDir, "merge-tree", "--write-tree", base, head],
    { encoding: "utf8" },
  );
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git merge-tree failed: ${result.stderr}`);
  }
  return result.status === 0;
}

/** Seed a bare remote with the base branch and two agent branches. */
async function seedRepository(
  root: string,
  env: Record<string, string>,
  baseChange: ScenarioOptions["baseChange"],
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
  // on; the deterministic agent's review and CI modes refuse any other content.
  await git("checkout", "-b", AGENT_BRANCH);
  writeFileSync(join(seed, "src/greeting.ts"), 'export const greeting = "Hello, world!";\n');
  await git("commit", "-am", "Implement greeting");
  await git("push", "origin", AGENT_BRANCH);
  await git("checkout", "-b", SECOND_BRANCH, BASE_BRANCH);
  await git("commit", "--allow-empty", "-m", "Second agent change");
  await git("push", "origin", SECOND_BRANCH);
  await git("checkout", BASE_BRANCH);
  if (baseChange === "conflict") {
    // Both sides edit the same line, so the forge reports `conflict`.
    writeFileSync(join(seed, "src/greeting.ts"), BASE_CONFLICT_GREETING);
    await git("commit", "-am", "Base greeting");
    await git("push", "origin", BASE_BRANCH);
  } else if (baseChange === "behind") {
    writeFileSync(join(seed, BASE_ONLY_FILE), "Target-only change.\n");
    await git("add", BASE_ONLY_FILE);
    await git("commit", "-m", "Base-only note");
    await git("push", "origin", BASE_BRANCH);
  }
  return { remote, seed };
}

/** Seeded repository, forge, and child environment shared by both fixture modes. */
interface PreparedForge {
  root: string;
  remote: string;
  seed: string;
  gitBin: string;
  forge: FakeGitlabForge;
  codeHostToken: string;
  invocationsPath: string;
  env: Record<string, string>;
}

/** Seed the repository and start the forge; `owned` records each resource as it exists. */
async function prepareForge(
  owned: ScenarioOwner,
  options: ScenarioOptions,
  rootPrefix: string,
): Promise<PreparedForge> {
  const gitBin = Bun.which("git");
  if (!gitBin) throw new Error("git is required for the GitLab forge fixture");
  const root = mkdtempSync(join(tmpdir(), rootPrefix));
  owned.root = root;
  const baseEnv = isolatedEnvironment(root);
  const { remote, seed } = await seedRepository(root, baseEnv, options.baseChange);

  const codeHostToken = `glpat-e2e-${randomBytes(16).toString("hex")}`;
  const forge = new FakeGitlabForge({
    gitDir: remote,
    gitBin,
    sourceBranch: AGENT_BRANCH,
    targetBranch: BASE_BRANCH,
    token: codeHostToken,
    ...(options.review
      ? {
          review: {
            discussionId: randomBytes(20).toString("hex"),
            noteId: 501,
            body: options.review.body,
            reviewer: "e2e-reviewer",
          },
        }
      : {}),
    ...(options.ci ? { ci: { ...options.ci, sha: revParse(gitBin, remote, AGENT_BRANCH) } } : {}),
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
  return { root, remote, seed, gitBin, forge, codeHostToken, invocationsPath, env };
}

/**
 * Seed the repository, start the forge, and start `webhook serve` with the
 * review queue live. All state lives under one temporary root that `owned`
 * records as soon as it exists.
 */
export async function openScenario(
  owned: ScenarioOwner,
  options: ScenarioOptions = {},
): Promise<Scenario> {
  const auth = options.auth ?? "signature";
  const signingToken = auth === "token" ? undefined : `whsec_${randomBytes(32).toString("base64")}`;
  const sharedToken =
    auth === "signature" ? undefined : `e2e-gitlab-token-${randomBytes(16).toString("hex")}`;
  const { env, ...prepared } = await prepareForge(owned, options, "devintern-e2e-webhook-gitlab-");
  const server = await WebhookServerFixture.start({
    root: prepared.root,
    env,
    cwd: prepared.seed,
    ...(signingToken ? { gitlabWebhookSigningToken: signingToken } : {}),
    ...(sharedToken ? { gitlabWebhookSecret: sharedToken } : {}),
  });
  owned.server = server;
  return { ...prepared, server, signingToken, sharedToken };
}

/** Forge and repository for running a standalone CLI command (no `webhook serve`). */
export interface StandaloneScenario extends Omit<PreparedForge, "env"> {
  /** Full allowlisted child environment for the CLI. */
  env: Record<string, string>;
  queueDbPath: string;
}

/**
 * Seed the repository and start the forge for standalone `address-review` /
 * `resolve-conflicts` runs. The CLI gets the same plain GitLab env and git
 * rewrite as the webhook scenario; no workspace is registered, so
 * `workspaceCredentialsForChange` finds no `workspace.toml` and the command
 * uses this env as-is.
 */
export async function openStandaloneScenario(
  owned: ScenarioOwner,
  options: Omit<ScenarioOptions, "auth"> = {},
): Promise<StandaloneScenario> {
  const prepared = await prepareForge(owned, options, "devintern-e2e-cli-gitlab-");
  const env = { ...isolatedEnvironment(prepared.root), ...prepared.env };
  // Pre-create the run-record DB so the legacy /tmp queue is never migrated in.
  ensureQueueDb(env.WEBHOOK_QUEUE_DB);
  return { ...prepared, env, queueDbPath: env.WEBHOOK_QUEUE_DB };
}

/** Run the built CLI from the seeded checkout with the standalone env. */
export function runStandaloneCli(
  scenario: StandaloneScenario,
  args: string[],
): Promise<CommandResult> {
  return command([process.execPath, cliPath, ...args], scenario.seed, scenario.env, 150_000);
}

/** Captured CLI output never contains the forge token, raw or URL-encoded. */
export function expectNoTokenInCliOutput(
  scenario: StandaloneScenario,
  result: CommandResult,
): void {
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output.includes(scenario.codeHostToken)).toBe(false);
  expect(output.includes(encodeURIComponent(scenario.codeHostToken))).toBe(false);
}

/**
 * How a delivery authenticates. Default: a Standard Webhooks signature when a
 * signing token is configured (signature and both modes), otherwise the
 * configured `X-Gitlab-Token`. `token` sends an explicit header value and no
 * signature headers; `none` sends neither. `forgedSignature` sends well-formed
 * Standard Webhooks headers signed with a random secret the server does not
 * know, plus `X-Gitlab-Token: token` when given.
 */
export type DeliveryAuth =
  | { kind: "default" }
  | { kind: "token"; value: string }
  | { kind: "none" }
  | { kind: "forgedSignature"; token?: string };

/** `v1,<base64>` Standard Webhooks signature of `id.timestamp.body` with a `whsec_` token. */
function standardWebhookHeaders(
  signingToken: string,
  webhookId: string,
  body: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const secret = Buffer.from(signingToken.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", secret)
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "webhook-id": webhookId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
}

export interface Delivery {
  status: number;
  body: WebhookResponse;
  /** Delivery id the server deduplicates on (`webhook-id`, or `idempotency-key` in token mode). */
  webhookId: string;
}

/** POST one GitLab delivery to `webhook serve`. */
export async function deliver(
  scenario: Scenario,
  event: GitLabEventName,
  payload: unknown,
  webhookId: string = randomUUID(),
  auth: DeliveryAuth = { kind: "default" },
): Promise<Delivery> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-gitlab-event": event,
  };
  if (auth.kind === "token") {
    headers["x-gitlab-token"] = auth.value;
    headers["idempotency-key"] = webhookId;
  } else if (auth.kind === "none") {
    headers["idempotency-key"] = webhookId;
  } else if (auth.kind === "forgedSignature") {
    const forgedToken = `whsec_${randomBytes(32).toString("base64")}`;
    Object.assign(headers, standardWebhookHeaders(forgedToken, webhookId, body));
    if (auth.token !== undefined) headers["x-gitlab-token"] = auth.token;
  } else if (scenario.signingToken) {
    Object.assign(headers, standardWebhookHeaders(scenario.signingToken, webhookId, body));
  } else if (scenario.sharedToken) {
    headers["x-gitlab-token"] = scenario.sharedToken;
    headers["idempotency-key"] = webhookId;
  }
  const response = await fetch(`${scenario.server.baseUrl}/webhooks/gitlab`, {
    method: "POST",
    headers,
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
export function noteHook(baseUrl: string, iid: number, note: string): Record<string, unknown> {
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
export function mergeRequestHook(
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

/**
 * `Merge Request Hook` for an open MR whose mergeability changed (an `update`
 * action with `detailed_merge_status`), as GitLab sends after the target moves.
 * `legacyOnly` omits `detailed_merge_status` and sends only the legacy
 * `merge_status` (`cannot_be_merged` / `can_be_merged`), as older GitLab
 * Self-Managed versions do.
 */
export function mergeabilityHook(
  baseUrl: string,
  iid: number,
  headSha: string,
  detailedMergeStatus: "conflict" | "need_rebase" | "mergeable",
  options: { legacyOnly?: boolean } = {},
): Record<string, unknown> {
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    user: { id: 42, username: "e2e-reviewer", name: "E2E Reviewer" },
    project: project(baseUrl),
    object_attributes: {
      iid,
      action: "update",
      state: "opened",
      source_branch: AGENT_BRANCH,
      target_branch: BASE_BRANCH,
      source_project_id: PROJECT_ID,
      target_project_id: PROJECT_ID,
      ...(options.legacyOnly ? {} : { detailed_merge_status: detailedMergeStatus }),
      merge_status: detailedMergeStatus === "mergeable" ? "can_be_merged" : "cannot_be_merged",
      last_commit: { id: headSha },
      url: `${baseUrl}/${PROJECT_PATH}/-/merge_requests/${iid}`,
    },
  };
}

/** `Pipeline Hook` for an MR pipeline, shaped like GitLab's payload. */
export function pipelineHook(
  baseUrl: string,
  iid: number,
  sha: string,
  status: string,
  pipelineId: number,
): Record<string, unknown> {
  return {
    object_kind: "pipeline",
    object_attributes: {
      id: pipelineId,
      iid: pipelineId,
      ref: AGENT_BRANCH,
      sha,
      status,
      source: "merge_request_event",
      url: `${baseUrl}/${PROJECT_PATH}/-/pipelines/${pipelineId}`,
    },
    merge_request: {
      id: 1000 + iid,
      iid,
      source_branch: AGENT_BRANCH,
      target_branch: BASE_BRANCH,
      state: "opened",
      url: `${baseUrl}/${PROJECT_PATH}/-/merge_requests/${iid}`,
    },
    user: { id: 42, username: "e2e-reviewer", name: "E2E Reviewer" },
    project: project(baseUrl),
  };
}

/** `Job Hook` for one job on the agent branch (GitLab sends no MR iid here). */
export function jobHook(
  baseUrl: string,
  sha: string,
  status: string,
  job: { id: number; name: string; pipelineId: number },
): Record<string, unknown> {
  return {
    object_kind: "build",
    ref: AGENT_BRANCH,
    tag: false,
    sha,
    build_id: job.id,
    build_name: job.name,
    build_stage: "test",
    build_status: status,
    build_allow_failure: false,
    pipeline_id: job.pipelineId,
    project_id: PROJECT_ID,
    project_name: PROJECT_PATH,
    user: { id: 42, username: "e2e-reviewer", name: "E2E Reviewer" },
    project: project(baseUrl),
  };
}

/** Register an agent MR the way the worker pipeline records one it opened. */
export function registerMergeRequest(scenario: Scenario, iid: number, branch: string): void {
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

export function agentPrRows(dbPath: string): AgentPrRow[] {
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

/** `processed_events` row for a delivery: `webhook-id:` in signature mode, `idempotency-key:` otherwise. */
function settledRow(dbPath: string, externalId: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const row = db
      .query("SELECT 1 FROM processed_events WHERE source = ? AND external_id = ?")
      .get(DELIVERY_SOURCE, externalId);
    return row !== null;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export function deliverySettled(dbPath: string, webhookId: string): boolean {
  return settledRow(dbPath, `webhook-id:${webhookId}`);
}

export function tokenDeliverySettled(dbPath: string, idempotencyKey: string): boolean {
  return settledRow(dbPath, `idempotency-key:${idempotencyKey}`);
}

export function webhookEventStatuses(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.query("SELECT status FROM webhook_events ORDER BY created_at").all() as Array<{
        status: string;
      }>
    ).map((row) => row.status);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function agentInvocations(path: string): AgentInvocation[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentInvocation);
}

function secrets(scenario: Scenario): string[] {
  return [scenario.codeHostToken, scenario.signingToken, scenario.sharedToken].filter(
    (value): value is string => Boolean(value),
  );
}

/** Server output with every token form removed, bounded for failure messages. */
export function diagnostics(scenario: Scenario): string {
  let text = `stdout:\n${scenario.server.stdout}\nstderr:\n${scenario.server.stderr}`;
  for (const secret of secrets(scenario)) {
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

export async function waitFor(
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

/** Server output never contains a webhook secret or the forge token, raw or URL-encoded. */
export function expectNoSecretsInOutput(scenario: Scenario): void {
  const output = `${scenario.server.stdout}\n${scenario.server.stderr}`;
  for (const secret of secrets(scenario)) {
    expect(output.includes(secret)).toBe(false);
    expect(output.includes(encodeURIComponent(secret))).toBe(false);
  }
}

/**
 * A valid note for an MR that is not in the registry is acknowledged and
 * settled without an agent run or any forge request. It is also the first
 * delivery that opens the worker state, which creates the `agent_prs` table.
 */
export async function expectUnregisteredNoteIgnored(scenario: Scenario): Promise<void> {
  const forgeBefore = scenario.forge.requests.length;
  const unmatched = await deliver(
    scenario,
    "Note Hook",
    noteHook(scenario.forge.baseUrl, UNREGISTERED_IID, "Please also handle this."),
  );
  expect(unmatched.status, diagnostics(scenario)).toBe(200);
  expect(unmatched.body.message).toBe("No registered GitLab MR matched");
  expect(unmatched.body.matchedMergeRequests).toBeUndefined();
  const settled = scenario.signingToken
    ? deliverySettled(scenario.server.queueDbPath, unmatched.webhookId)
    : tokenDeliverySettled(scenario.server.queueDbPath, unmatched.webhookId);
  expect(settled).toBe(true);
  expect(scenario.forge.requests.length).toBe(forgeBefore);
  expect(agentInvocations(scenario.invocationsPath)).toEqual([]);
}
