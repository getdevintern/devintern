/**
 * Relayed v2 GitLab code-host events drive registered-MR jobs offline.
 *
 * A real `devintern worker` long-polls a loopback {@link FakeRelay} and talks
 * to a loopback {@link FakeGitlabForge} (behind {@link GitlabForgeProxy}, which
 * adds the project-membership route the registered-MR poller needs). Git
 * fetch/push is rewritten onto a local bare repository. `poll_interval` is
 * far longer than the test, so after the startup tick (which runs before the
 * MR is registered) only a relay envelope can make the worker look at the MR.
 *
 * - `change.feedback` for registered MR !1 runs address-review on the forge's
 *   unresolved reviewer discussion, pushes a commit, and replies; a redelivery
 *   of the same `deliveryId` is deduplicated before any forge request.
 * - Envelopes the acquirer must ignore (v1 with `codeHost`, provider/source
 *   mismatch, no change/branch/headSha, unregistered project or IID) are
 *   acknowledged without a job or forge request, and the cursor moves past
 *   them so a later valid envelope still runs.
 * - `change.changed` for a registered MR that conflicts with its target runs
 *   conflict resolution once, after which the branch merges cleanly.
 *
 * - `ci.changed` for a registered MR whose current head has a failed pipeline
 *   reads the pipeline, job, and trace and runs CI repair once. A passing
 *   pipeline, a stale head SHA (after the repair commit), and a redelivered
 *   `deliveryId` run nothing; the cursor still advances past each.
 * - A `ci.changed` envelope that names the change only by `ref.headSha` still
 *   resolves the registered MR and runs CI repair.
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, relative } from "node:path";
import { FakeGitlabForge } from "../../helpers/fake-gitlab-forge";
import type {
  FakeGitlabCiFailure,
  FakeGitlabReviewDiscussion,
} from "../../helpers/fake-gitlab-forge";
import { FakeRelay } from "../../helpers/fake-relay";
import type { FakeRelayCodeHostIdentity, FakeRelayEnvelope } from "../../helpers/fake-relay";
import { GitlabForgeProxy } from "../../helpers/gitlab-forge-proxy";
import { checkedCommand } from "../../helpers/process";
import { relayStatePath, writeRelayState } from "../../helpers/relay-state";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

const PROJECT_PATH = "fixture/repo";
const AGENT_BRANCH = "devintern/e2e-1-greeting";
const REVIEWER_ID = 42;
/** GitLab Developer access, the poller's minimum for an unassigned reviewer. */
const DEVELOPER_ACCESS = 30;
/** Far longer than the test: the GitLab poll timer can never fire during it. */
const POLL_INTERVAL_SECONDS = 3600;
/**
 * The registry row predates the forge's fixed discussion timestamp
 * (2026-01-01); the poller ignores notes older than the MR's registration.
 */
const REGISTERED_AT = Date.parse("2025-12-01T00:00:00.000Z");
/** Upper bound from publish to agent start; the poll timer is an hour. */
const RELAY_START_BOUND_MS = 30_000;
const JOB_TIMEOUT_MS = 120_000;
const WORLD_GREETING = 'export const greeting = "Hello, world!";\n';
const BRANCH_GREETING = 'export const greeting = "Hello, branch!";\n';
const BASE_GREETING = 'export const greeting = "Hello, base!";\n';
const MERGED_GREETING = 'export const greeting = "Hello, merged!";\n';
const FEEDBACK_SOURCE = "gitlab:registered-mr-feedback";
const CI_GREETING = 'export const greeting = "Hello, CI!";\n';
const PIPELINE_ID = 3001;
const JOB_ID = 4001;

interface Harness {
  worker: WorkerFixture;
  forge: FakeGitlabForge;
  proxy: GitlabForgeProxy;
  relay: FakeRelay;
  gitBin: string;
  gitLog: string;
  codeHost: FakeRelayCodeHostIdentity;
  secrets: string[];
}

/** Everything a test created, released in `finally` even after a failure. */
interface Owned {
  worker?: WorkerFixture;
  forge?: FakeGitlabForge;
  proxy?: GitlabForgeProxy;
  relay?: FakeRelay;
}

/** Quote a string for a POSIX single-quoted shell literal. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function redact(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[redacted]");
    redacted = redacted.split(encodeURIComponent(secret)).join("[redacted]");
  }
  return redacted;
}

function gitOutput(gitBin: string, gitDir: string, args: string[]): string {
  const result = spawnSync(gitBin, ["--git-dir", gitDir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function revParse(gitBin: string, gitDir: string, branch: string): string {
  return gitOutput(gitBin, gitDir, ["rev-parse", `refs/heads/${branch}`]);
}

function showFile(gitBin: string, gitDir: string, branch: string, path: string): string {
  const result = spawnSync(gitBin, ["--git-dir", gitDir, "show", `refs/heads/${branch}:${path}`], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout : "";
}

/** `git merge-tree --write-tree` exit status: 0 clean, 1 conflicted. */
function mergeTreeStatus(gitBin: string, gitDir: string, target: string, source: string): number {
  const result = spawnSync(
    gitBin,
    [
      "--git-dir",
      gitDir,
      "merge-tree",
      "--write-tree",
      `refs/heads/${target}`,
      `refs/heads/${source}`,
    ],
    { encoding: "utf8" },
  );
  return result.status ?? -1;
}

function pushLines(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line === "push" || line.startsWith("push "));
}

/**
 * Put a logging `git` wrapper first on PATH and rewrite the forge URL onto the
 * bare repo. `git remote get-url` would apply `insteadOf` and show the bare
 * path, which the GitLab paths compare to the MR project, so the wrapper drops
 * the rewrite for that call only (same technique as the conflict failover test).
 */
function installGitRewrite(worker: WorkerFixture, gitBin: string, httpUrl: string): string {
  const dir = join(worker.root, "git-bin");
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "git-argv.log");
  const wrapper = join(dir, "git");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shQuote(logPath)}`,
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
  worker.env.PATH = `${dir}${delimiter}${worker.env.PATH ?? ""}`;
  Object.assign(worker.env, {
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_CONFIG_KEY_3: `url.${worker.remote}.insteadOf`,
    GIT_CONFIG_VALUE_3: httpUrl,
  });
  return logPath;
}

/**
 * Point the repo at the forge URL and enable automatic conflict resolution.
 * CI repair is on only when the forge serves a pipeline (`ciRepair`).
 */
function patchWorkspace(worker: WorkerFixture, remoteUrl: string, ciRepair: boolean): void {
  const path = join(worker.workspaceDir, "workspace.toml");
  const remoteLine = `remote = "${worker.remote}"`;
  let text = readFileSync(path, "utf8");
  if (!text.includes(remoteLine) || !text.includes("[workspace]\ndashboard = false\n")) {
    throw new Error("generated workspace.toml did not have the expected shape");
  }
  text = text.replace(remoteLine, `remote = "${remoteUrl}"`);
  text = text.replace(
    "[workspace]\ndashboard = false\n",
    `[workspace]\ndashboard = false\nci_failure_fix = ${ciRepair}\nconflict_resolution = "auto"\n`,
  );
  writeFileSync(path, text);
}

/** The agent branch already holds the implementation the reviewer comments on. */
async function seedReviewBranch(worker: WorkerFixture, gitBin: string): Promise<void> {
  const git = (...args: string[]) => checkedCommand([gitBin, ...args], worker.seed, worker.env);
  await git("checkout", "-b", AGENT_BRANCH);
  writeFileSync(join(worker.seed, "src/greeting.ts"), WORLD_GREETING);
  await git("commit", "-am", "Implement greeting");
  await git("push", "origin", AGENT_BRANCH);
  await git("checkout", worker.baseBranch);
}

/** Diverge the agent branch and the target on the same line. */
async function seedConflictBranches(worker: WorkerFixture, gitBin: string): Promise<void> {
  const git = (...args: string[]) => checkedCommand([gitBin, ...args], worker.seed, worker.env);
  await git("checkout", "-b", AGENT_BRANCH);
  writeFileSync(join(worker.seed, "src/greeting.ts"), BRANCH_GREETING);
  await git("commit", "-am", "Branch greeting");
  await git("push", "origin", AGENT_BRANCH);
  await git("checkout", worker.baseBranch);
  writeFileSync(join(worker.seed, "src/greeting.ts"), BASE_GREETING);
  await git("commit", "-am", "Base greeting");
  await git("push", "origin", worker.baseBranch);
}

/** Record MR !1 the way the worker pipeline registers an MR it opened. */
function registerMergeRequest(harness: Harness): void {
  const db = new Database(harness.worker.dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run(
      `INSERT INTO agent_prs (
         provider, instance_url, project_id, project_path, change_number, web_url,
         repo, pr_number, branch, state, created_at, updated_at
       ) VALUES ('gitlab', ?, '1', ?, 1, ?, ?, 1, ?, 'open', ?, ?)`,
      [
        harness.codeHost.instanceUrl,
        PROJECT_PATH,
        `${harness.codeHost.instanceUrl}/${PROJECT_PATH}/-/merge_requests/1`,
        PROJECT_PATH,
        AGENT_BRANCH,
        REGISTERED_AT,
        REGISTERED_AT,
      ],
    );
  } finally {
    db.close();
  }
}

function processedEvents(dbPath: string, source: string): string[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    return (
      db.query("SELECT external_id FROM processed_events WHERE source = ?").all(source) as Array<{
        external_id: string;
      }>
    ).map((row) => row.external_id);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Build the worker, relay, forge, and proxy; seed the branches; and start the
 * worker. Returns once the startup poll tick has run with no MR registered and
 * the relay is long-polling from cursor 0. The caller registers the MR.
 */
async function openHarness(
  owned: Owned,
  scenario: {
    review?: Omit<FakeGitlabReviewDiscussion, "reviewer">;
    conflict?: boolean;
    /** A failed pipeline served for the agent branch's seeded head. */
    ci?: Omit<FakeGitlabCiFailure, "sha">;
  },
): Promise<Harness> {
  const gitBin = Bun.which("git");
  if (!gitBin) throw new Error("git is required for the relay GitLab fixture");
  const nonce = randomBytes(12).toString("hex");
  const relayToken = `drt_e2e${nonce}`;
  const forgeToken = `glpat-e2e-${randomBytes(16).toString("hex")}`;
  const secrets = [relayToken, forgeToken];

  const relay = new FakeRelay({ token: relayToken, holdMs: 1_000 });
  owned.relay = relay;
  const worker = new WorkerFixture({
    rootPrefix: "devintern-e2e-relay-gitlab-",
    // A disabled automation is the configured work that keeps the worker up.
    automations: [
      {
        id: "keep-alive",
        enabled: false,
        prompt: "This disabled automation only keeps the workspace worker alive.",
        cron: "0 0 1 1 *",
      },
    ],
    workspaceTomlExtra: `poll_interval = ${POLL_INTERVAL_SECONDS}`,
    env: { WORKER_RELAY_URL: relay.url },
  });
  owned.worker = worker;
  await worker.prepare();
  if (scenario.conflict) await seedConflictBranches(worker, gitBin);
  else await seedReviewBranch(worker, gitBin);

  const forge = new FakeGitlabForge({
    gitDir: worker.remote,
    gitBin,
    sourceBranch: AGENT_BRANCH,
    targetBranch: worker.baseBranch,
    token: forgeToken,
    ...(scenario.review ? { review: { ...scenario.review, reviewer: "e2e-reviewer" } } : {}),
    ...(scenario.ci
      ? { ci: { ...scenario.ci, sha: revParse(gitBin, worker.remote, AGENT_BRANCH) } }
      : {}),
  });
  owned.forge = forge;
  const proxy = new GitlabForgeProxy({
    forgeUrl: forge.baseUrl,
    token: forgeToken,
    members: { [REVIEWER_ID]: DEVELOPER_ACCESS },
  });
  owned.proxy = proxy;

  const remoteUrl = `${proxy.baseUrl}/${PROJECT_PATH}.git`;
  Object.assign(worker.env, {
    DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
    GITLAB_CODE_HOST_URL: proxy.baseUrl,
    GITLAB_CODE_HOST_TOKEN: forgeToken,
    DEVINTERN_REVIEW_WORKTREE_PATH: join(worker.root, "review-worktree"),
  });
  const gitLog = installGitRewrite(worker, gitBin, remoteUrl);
  patchWorkspace(worker, remoteUrl, Boolean(scenario.ci));
  writeRelayState(worker.workspaceDir, relay.url, relayToken);

  const harness: Harness = {
    worker,
    forge,
    proxy,
    relay,
    gitBin,
    gitLog,
    codeHost: {
      provider: "gitlab",
      instanceUrl: proxy.baseUrl,
      projectId: "1",
      projectPath: PROJECT_PATH,
    },
    secrets,
  };

  worker.start();
  await worker.waitForReady();
  await worker.waitForOutput(/Relay connected: .* \(Mode 2\)/, 20_000, "the relay acquirer");
  // The poller logs this, then runs its startup tick synchronously over an
  // empty registry; no MR exists yet, so that tick cannot run a job.
  await worker.waitForOutput(
    new RegExp(`Polling reviews on 0 registered GitLab MR\\(s\\) every ${POLL_INTERVAL_SECONDS}s`),
    20_000,
    "the GitLab registered-MR poller",
  );
  await waitForCursor(harness, 0, "the first relay long poll from cursor 0");
  return harness;
}

function diagnostics(harness: Harness, detail = ""): string {
  const { worker, forge, proxy, relay } = harness;
  return redact(
    [
      detail,
      `relay requests: ${JSON.stringify(relay.requests)}`,
      `relay unexpected: ${JSON.stringify(relay.unexpectedRequests)}`,
      `forge requests: ${JSON.stringify(forge.requests)}`,
      `forge unexpected: ${JSON.stringify(forge.unexpected)}`,
      `forge auth failures: ${JSON.stringify(forge.authFailures)}`,
      `member lookups: ${JSON.stringify(proxy.memberLookups)}`,
      `replies: ${forge.discussionReplies.length}, notes: ${forge.notes.length}`,
      `agent: ${JSON.stringify(agentRuns(worker))}`,
      `pushes: ${JSON.stringify(pushLines(harness.gitLog))}`,
      worker.tail(),
    ]
      .filter(Boolean)
      .join("\n"),
    harness.secrets,
  );
}

/**
 * Wait until the worker polls from `seq`. The acquirer persists the cursor
 * only after an envelope's dispatch settles, so this also waits for its job.
 */
function waitForCursor(harness: Harness, seq: number, label: string, timeoutMs = 30_000) {
  return harness.worker.waitFor(
    label,
    () => (harness.relay.requests.some((r) => r.cursor === String(seq)) ? true : undefined),
    timeoutMs,
  );
}

/** Deterministic-agent records, including the prompt markers each run saw. */
function agentRuns(worker: WorkerFixture): Array<{ mode: string; promptMarkers?: string[] }> {
  const path = worker.env.E2E_AGENT_INVOCATIONS;
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { mode: string; promptMarkers?: string[] });
}

/** First agent start recorded at or after `since`. */
function agentStartSince(worker: WorkerFixture, since: number): number | undefined {
  return worker.agentTimeline().find((event) => event.event === "start" && event.at >= since)?.at;
}

/** Recursively list files under `dir`, skipping git object stores. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry.endsWith(".git")) continue;
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

/**
 * Neither token (raw or URL-encoded) reaches worker output, logs, or any file
 * the run wrote. The seeded pairing file is the one place the relay token is
 * expected, so it is excluded.
 */
function expectNoSecretLeaks(harness: Harness): void {
  const { worker, secrets } = harness;
  const pairing = relayStatePath(worker.workspaceDir);
  for (const secret of secrets) {
    for (const form of [secret, encodeURIComponent(secret)]) {
      expect(worker.logs.includes(form), "worker output contains a credential").toBe(false);
    }
  }
  const leaked = listFiles(worker.root)
    .filter((path) => path !== pairing)
    .filter((path) => {
      const content = readFileSync(path).toString("latin1");
      return secrets.some(
        (secret) => content.includes(secret) || content.includes(encodeURIComponent(secret)),
      );
    })
    .map((path) => relative(worker.root, path));
  expect(leaked, "run artifacts contain a credential").toEqual([]);
}

/** Release every resource; report (or throw) anything that could not be removed. */
async function release(owned: Owned, failure: unknown): Promise<void> {
  const residue: string[] = [];
  const attempt = async (label: string, step: () => Promise<void> | void) => {
    try {
      await step();
    } catch (error) {
      residue.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // Stop the worker first so it is not polling servers that just vanished.
  const root = owned.worker?.root;
  await attempt("worker fixture", () => owned.worker?.dispose());
  await attempt("fake relay", () => owned.relay?.cleanup());
  await attempt("forge proxy", () => owned.proxy?.stop());
  await attempt("fake GitLab forge", () => owned.forge?.stop());
  if (root && existsSync(root)) residue.push(`temp root ${root} was not removed`);
  if (residue.length === 0) return;
  const message = `Cleanup left residue:\n${residue.join("\n")}`;
  if (failure) console.error(message);
  else throw new Error(message);
}

cliTest(
  "relayed v2 GitLab change.feedback runs address-review on a registered MR; ignored envelopes do not pin the cursor",
  async () => {
    const owned: Owned = {};
    let failure: unknown;
    try {
      const marker = `E2EPROMPTMARKER${randomBytes(6).toString("hex").toUpperCase()}`;
      const discussionId = randomBytes(20).toString("hex");
      const harness = await openHarness(owned, {
        review: {
          discussionId,
          noteId: 501,
          body: `Please greet the reviewer instead of the world. E2E_REVIEW_GREETING ${marker}`,
        },
      });
      const { worker, forge, proxy, relay, gitBin, codeHost } = harness;
      registerMergeRequest(harness);
      const headBefore = revParse(gitBin, worker.remote, AGENT_BRANCH);
      const forgeBaseline = forge.requests.length;
      expect(agentRuns(worker), diagnostics(harness)).toEqual([]);

      // Envelope gate. Each variant names the registered MR (or a near miss)
      // but must be acknowledged without reaching the reconciler's forge reads.
      const nonce = randomBytes(6).toString("hex");
      const ignored: FakeRelayEnvelope[] = [
        relay.publishCodeHostEvent({
          eventType: "change.feedback",
          version: 1,
          source: "gitlab",
          codeHost,
          ref: { change: 1 },
          deliveryId: `dlv-v1-${nonce}`,
        }),
        relay.publishCodeHostEvent({
          eventType: "change.feedback",
          source: "github",
          codeHost,
          ref: { change: 1 },
          deliveryId: `dlv-provider-mismatch-${nonce}`,
        }),
        relay.publishCodeHostEvent({
          eventType: "change.feedback",
          source: "gitlab",
          codeHost,
          ref: {},
          deliveryId: `dlv-no-ref-${nonce}`,
        }),
        relay.publishCodeHostEvent({
          eventType: "change.feedback",
          source: "gitlab",
          codeHost: { ...codeHost, projectId: "999", projectPath: "fixture/other" },
          ref: { change: 1 },
          deliveryId: `dlv-unregistered-project-${nonce}`,
        }),
        relay.publishCodeHostEvent({
          eventType: "change.feedback",
          source: "gitlab",
          codeHost,
          ref: { change: 9 },
          deliveryId: `dlv-unregistered-iid-${nonce}`,
        }),
      ];
      const lastIgnored = ignored.at(-1)!;
      await waitForCursor(harness, lastIgnored.seq, "the poll after the ignored envelopes");
      const gated = diagnostics(harness, "after ignored envelopes");
      expect(agentRuns(worker), gated).toEqual([]);
      expect(forge.requests.length, gated).toBe(forgeBaseline);
      expect(proxy.memberLookups, gated).toEqual([]);
      expect(forge.mutations(), gated).toEqual([]);
      expect(revParse(gitBin, worker.remote, AGENT_BRANCH), gated).toBe(headBefore);
      expect(worker.logs, gated).not.toContain("new review feedback");

      // A valid envelope after the ignored ones is still processed.
      const deliveryId = `dlv-feedback-${nonce}`;
      const publishedAt = Date.now();
      const feedback = relay.publishCodeHostEvent({
        eventType: "change.feedback",
        source: "gitlab",
        codeHost,
        ref: { change: 1 },
        deliveryId,
      });
      expect(feedback.seq).toBe(lastIgnored.seq + 1);
      await waitForCursor(
        harness,
        feedback.seq,
        "the address-review job and cursor advance",
        JOB_TIMEOUT_MS,
      );
      const delivered = diagnostics(harness, "after change.feedback");

      const startedAt = agentStartSince(worker, publishedAt);
      expect(startedAt, delivered).toBeDefined();
      expect(startedAt! - publishedAt, delivered).toBeLessThan(RELAY_START_BOUND_MS);
      expect(agentRuns(worker), delivered).toEqual([{ mode: "review", promptMarkers: [marker] }]);
      expect(worker.logs, delivered).toContain(`new review feedback on ${PROJECT_PATH}!1`);

      const headAfter = revParse(gitBin, worker.remote, AGENT_BRANCH);
      expect(headAfter, delivered).not.toBe(headBefore);
      expect(showFile(gitBin, worker.remote, AGENT_BRANCH, "src/greeting.ts"), delivered).toBe(
        'export const greeting = "Hello, reviewer!";\n',
      );
      expect(forge.discussionReplies, delivered).toHaveLength(1);
      expect(forge.discussionReplies[0]?.discussionId, delivered).toBe(discussionId);
      expect(forge.discussionReplies[0]?.body, delivered).toContain(
        "Addressed this feedback in the latest commit.",
      );
      expect(forge.mutations(), delivered).toEqual([
        {
          method: "POST",
          path: expect.stringMatching(
            /^\/api\/v4\/projects\/1\/merge_requests\/1\/discussions\/[^/]+\/notes$/,
          ),
        },
      ]);
      expect(forge.notes, delivered).toEqual([]);
      expect(forge.unexpected, delivered).toEqual([]);
      expect(forge.authFailures, delivered).toEqual([]);
      expect(proxy.memberLookups.length, delivered).toBeGreaterThan(0);
      expect(processedEvents(worker.dbPath, FEEDBACK_SOURCE), delivered).toContain(
        `${codeHost.instanceUrl}:1!1:note:501`,
      );

      // Relay dedupe covers code-host envelopes: a redelivery of the same
      // deliveryId under a new seq is skipped before the reconciler, so the
      // forge is not even read.
      const forgeBeforeReplay = forge.requests.length;
      const replay = relay.publishCodeHostEvent({
        eventType: "change.feedback",
        source: "gitlab",
        codeHost,
        ref: { change: 1 },
        deliveryId,
      });
      await waitForCursor(harness, replay.seq, "the poll after the replayed delivery");
      const replayed = diagnostics(harness, "after replay");
      expect(agentRuns(worker), replayed).toHaveLength(1);
      expect(forge.requests.length, replayed).toBe(forgeBeforeReplay);
      expect(forge.discussionReplies, replayed).toHaveLength(1);
      expect(revParse(gitBin, worker.remote, AGENT_BRANCH), replayed).toBe(headAfter);

      expect(
        relay.requests.every((request) => request.authorized),
        replayed,
      ).toBe(true);
      expect(relay.unexpectedRequests, replayed).toEqual([]);
      expect(worker.running, replayed).toBe(true);
      expectNoSecretLeaks(harness);
    } catch (error) {
      failure = error;
    } finally {
      await release(owned, failure);
    }
    if (failure) throw failure;
  },
  240_000,
);

cliTest(
  "relayed v2 GitLab change.changed resolves a conflicting registered MR once",
  async () => {
    const owned: Owned = {};
    let failure: unknown;
    try {
      const harness = await openHarness(owned, { conflict: true });
      const { worker, forge, relay, gitBin, codeHost } = harness;
      const headSha = revParse(gitBin, worker.remote, AGENT_BRANCH);
      const baseSha = revParse(gitBin, worker.remote, worker.baseBranch);
      const mergeBaseSha = gitOutput(gitBin, worker.remote, [
        "merge-base",
        `refs/heads/${AGENT_BRANCH}`,
        `refs/heads/${worker.baseBranch}`,
      ]);
      expect(mergeTreeStatus(gitBin, worker.remote, worker.baseBranch, AGENT_BRANCH)).toBe(1);
      registerMergeRequest(harness);
      expect(agentRuns(worker), diagnostics(harness)).toEqual([]);
      expect(pushLines(harness.gitLog), diagnostics(harness)).toEqual([]);

      const nonce = randomBytes(6).toString("hex");
      const publishedAt = Date.now();
      const changed = relay.publishCodeHostEvent({
        eventType: "change.changed",
        source: "gitlab",
        codeHost,
        ref: { change: 1, branch: AGENT_BRANCH, headSha },
        deliveryId: `dlv-changed-${nonce}`,
      });
      await waitForCursor(
        harness,
        changed.seq,
        "the conflict job and cursor advance",
        JOB_TIMEOUT_MS,
      );
      const resolved = diagnostics(harness, "after change.changed");

      const startedAt = agentStartSince(worker, publishedAt);
      expect(startedAt, resolved).toBeDefined();
      expect(startedAt! - publishedAt, resolved).toBeLessThan(RELAY_START_BOUND_MS);
      expect(agentRuns(worker), resolved).toEqual([{ mode: "conflict" }]);
      expect(showFile(gitBin, worker.remote, AGENT_BRANCH, "src/greeting.ts"), resolved).toBe(
        MERGED_GREETING,
      );
      // The target is untouched; the MR branch now merges into it cleanly.
      expect(revParse(gitBin, worker.remote, worker.baseBranch), resolved).toBe(baseSha);
      expect(
        mergeTreeStatus(gitBin, worker.remote, worker.baseBranch, AGENT_BRANCH),
        resolved,
      ).toBe(0);
      expect(
        gitOutput(gitBin, worker.remote, [
          "rev-list",
          "--parents",
          "-n",
          "1",
          `refs/heads/${AGENT_BRANCH}`,
        ])
          .split(/\s+/)
          .slice(1),
        resolved,
      ).toEqual([headSha, baseSha]);
      expect(pushLines(harness.gitLog), resolved).toEqual([`push origin ${AGENT_BRANCH}`]);
      expect(processedEvents(worker.dbPath, FEEDBACK_SOURCE), resolved).toContain(
        `sync:${codeHost.instanceUrl}:1!1:${mergeBaseSha}:${headSha}`,
      );
      expect(
        forge.mutations().every((request) => request.path.endsWith("/merge_requests/1/notes")),
        resolved,
      ).toBe(true);
      expect(forge.unexpected, resolved).toEqual([]);
      expect(forge.authFailures, resolved).toEqual([]);

      // Another change.changed hint for the now-mergeable MR runs nothing.
      const again = relay.publishCodeHostEvent({
        eventType: "change.changed",
        source: "gitlab",
        codeHost,
        ref: { change: 1 },
        deliveryId: `dlv-changed-again-${nonce}`,
      });
      await waitForCursor(harness, again.seq, "the poll after the second change.changed");
      const settled = diagnostics(harness, "after second change.changed");
      expect(agentRuns(worker), settled).toEqual([{ mode: "conflict" }]);
      expect(pushLines(harness.gitLog), settled).toHaveLength(1);

      expect(
        relay.requests.every((request) => request.authorized),
        settled,
      ).toBe(true);
      expect(relay.unexpectedRequests, settled).toEqual([]);
      expect(worker.running, settled).toBe(true);
      expectNoSecretLeaks(harness);
    } catch (error) {
      failure = error;
    } finally {
      await release(owned, failure);
    }
    if (failure) throw failure;
  },
  240_000,
);

/** A failed job whose name and trace each carry a unique prompt marker. */
function ciScenario(): {
  jobMarker: string;
  traceMarker: string;
  ci: Omit<FakeGitlabCiFailure, "sha">;
} {
  const jobMarker = `E2EPROMPTMARKERJOB${randomBytes(6).toString("hex").toUpperCase()}`;
  const traceMarker = `E2EPROMPTMARKERTRACE${randomBytes(6).toString("hex").toUpperCase()}`;
  return {
    jobMarker,
    traceMarker,
    ci: {
      pipelineId: PIPELINE_ID,
      jobId: JOB_ID,
      jobName: `unit-${jobMarker}`,
      // E2E_CI_FIX_MARKER selects the deterministic agent's CI-repair mode.
      trace: `$ bun test\nE2E_CI_FIX_MARKER greeting assertion failed ${traceMarker}\nJob failed: exit code 1\n`,
    },
  };
}

/** Pipeline, job, trace, and commit-status reads, in order. */
function ciRequests(forge: FakeGitlabForge, from = 0): string[] {
  return forge.requests
    .slice(from)
    .map((request) => request.path)
    .filter((path) => /\/(pipelines|jobs|statuses)(\/|\?|$)/.test(path));
}

function pipelinesFor(sha: string): string {
  return `/api/v4/projects/1/pipelines?sha=${sha}&per_page=100&page=1`;
}

/**
 * Exactly one CI-repair run saw the failed job and trace (which reached the
 * prompt only via the forge), pushed one commit on top of `headBefore`, and
 * was recorded with the CI-repair origin. Returns the new head.
 */
function expectCiRepair(
  harness: Harness,
  headBefore: string,
  markers: { jobMarker: string; traceMarker: string },
  detail: string,
): string {
  const { worker, forge, gitBin } = harness;
  const runs = agentRuns(worker);
  expect(runs, detail).toHaveLength(1);
  expect(runs[0]?.mode, detail).toBe("ci");
  expect(runs[0]?.promptMarkers ?? [], detail).toContain(markers.jobMarker);
  expect(runs[0]?.promptMarkers ?? [], detail).toContain(markers.traceMarker);

  const headAfter = revParse(gitBin, worker.remote, AGENT_BRANCH);
  expect(headAfter, detail).not.toBe(headBefore);
  // A fast-forward on the old head: history was not rewritten.
  expect(
    gitOutput(gitBin, worker.remote, ["rev-list", "--parents", "-n", "1", headAfter])
      .split(/\s+/)
      .slice(1),
    detail,
  ).toEqual([headBefore]);
  expect(showFile(gitBin, worker.remote, AGENT_BRANCH, "src/greeting.ts"), detail).toBe(
    CI_GREETING,
  );
  expect(pushLines(harness.gitLog), detail).toHaveLength(1);
  expect(
    worker.runRecords().filter((run) => run.origin === "ci_fix"),
    detail,
  ).toHaveLength(1);

  const paths = ciRequests(forge);
  expect(paths, detail).toContain(pipelinesFor(headBefore));
  expect(paths, detail).toContain(
    `/api/v4/projects/1/pipelines/${PIPELINE_ID}/jobs?include_retried=false&per_page=100&page=1`,
  );
  expect(paths, detail).toContain(`/api/v4/projects/1/jobs/${JOB_ID}/trace`);
  expect(forge.unexpected, detail).toEqual([]);
  expect(forge.authFailures, detail).toEqual([]);
  return headAfter;
}

cliTest(
  "relayed v2 GitLab ci.changed runs CI repair once on a failed head; passing, stale, and redelivered envelopes run nothing",
  async () => {
    const owned: Owned = {};
    let failure: unknown;
    try {
      const fixture = ciScenario();
      const harness = await openHarness(owned, { ci: fixture.ci });
      const { worker, forge, relay, gitBin, codeHost } = harness;
      registerMergeRequest(harness);
      const headBefore = revParse(gitBin, worker.remote, AGENT_BRANCH);
      const nonce = randomBytes(6).toString("hex");
      expect(agentRuns(worker), diagnostics(harness)).toEqual([]);

      // A passing pipeline on the current head: CI is read, no trace, no run.
      forge.setCiStatus("success");
      const passingFrom = forge.requests.length;
      const passing = relay.publishCiChanged({
        codeHost,
        ref: { change: 1, headSha: headBefore },
        deliveryId: `dlv-ci-success-${nonce}`,
      });
      await waitForCursor(harness, passing.seq, "the poll after the passing ci.changed");
      const green = diagnostics(harness, "after passing ci.changed");
      expect(ciRequests(forge, passingFrom), green).toContain(pipelinesFor(headBefore));
      expect(
        ciRequests(forge, passingFrom).some((path) => path.endsWith("/trace")),
        green,
      ).toBe(false);
      expect(agentRuns(worker), green).toEqual([]);
      expect(pushLines(harness.gitLog), green).toEqual([]);

      // The pipeline on the same head now fails: one CI repair run.
      forge.setCiStatus("failed");
      const deliveryId = `dlv-ci-failed-${nonce}`;
      const publishedAt = Date.now();
      const failed = relay.publishCiChanged({
        codeHost,
        ref: { change: 1, branch: AGENT_BRANCH, headSha: headBefore },
        deliveryId,
      });
      await waitForCursor(
        harness,
        failed.seq,
        "the CI-repair job and cursor advance",
        JOB_TIMEOUT_MS,
      );
      const repaired = diagnostics(harness, "after failed ci.changed");
      const startedAt = agentStartSince(worker, publishedAt);
      expect(startedAt, repaired).toBeDefined();
      expect(startedAt! - publishedAt, repaired).toBeLessThan(RELAY_START_BOUND_MS);
      const headAfter = expectCiRepair(harness, headBefore, fixture, repaired);

      // A ci.changed for the pre-repair SHA is stale: the worker reads the MR's
      // current head (the repair commit, which has no pipeline) and runs nothing.
      const staleFrom = forge.requests.length;
      const stale = relay.publishCiChanged({
        codeHost,
        ref: { change: 1, headSha: headBefore },
        deliveryId: `dlv-ci-stale-${nonce}`,
      });
      await waitForCursor(harness, stale.seq, "the poll after the stale ci.changed");
      const staleDetail = diagnostics(harness, "after stale ci.changed");
      expect(ciRequests(forge, staleFrom), staleDetail).toContain(pipelinesFor(headAfter));
      expect(ciRequests(forge, staleFrom), staleDetail).not.toContain(pipelinesFor(headBefore));
      expect(
        ciRequests(forge, staleFrom).some((path) => path.endsWith("/trace")),
        staleDetail,
      ).toBe(false);
      expect(agentRuns(worker), staleDetail).toHaveLength(1);
      expect(revParse(gitBin, worker.remote, AGENT_BRANCH), staleDetail).toBe(headAfter);

      // A redelivery of the failed envelope's deliveryId is deduplicated before
      // any forge request, and the cursor still moves past it.
      const forgeBeforeReplay = forge.requests.length;
      const replay = relay.publishCiChanged({
        codeHost,
        ref: { change: 1, branch: AGENT_BRANCH, headSha: headBefore },
        deliveryId,
      });
      await waitForCursor(harness, replay.seq, "the poll after the replayed ci.changed");
      const replayed = diagnostics(harness, "after replayed ci.changed");
      expect(forge.requests.length, replayed).toBe(forgeBeforeReplay);
      expect(agentRuns(worker), replayed).toHaveLength(1);
      expect(pushLines(harness.gitLog), replayed).toHaveLength(1);

      expect(
        relay.requests.every((request) => request.authorized),
        replayed,
      ).toBe(true);
      expect(relay.unexpectedRequests, replayed).toEqual([]);
      expect(worker.running, replayed).toBe(true);
      expectNoSecretLeaks(harness);
    } catch (error) {
      failure = error;
    } finally {
      await release(owned, failure);
    }
    if (failure) throw failure;
  },
  240_000,
);

cliTest(
  "relayed v2 GitLab ci.changed identified only by ref.headSha runs CI repair on the registered MR",
  async () => {
    const owned: Owned = {};
    let failure: unknown;
    try {
      const fixture = ciScenario();
      const harness = await openHarness(owned, { ci: fixture.ci });
      const { worker, relay, gitBin, codeHost } = harness;
      registerMergeRequest(harness);
      const headBefore = revParse(gitBin, worker.remote, AGENT_BRANCH);
      expect(agentRuns(worker), diagnostics(harness)).toEqual([]);

      // No `change` and no `branch`: the acquirer forwards the envelope and the
      // project's registered MRs are reconciled against their current heads.
      const headOnly = relay.publishCiChanged({
        codeHost,
        ref: { headSha: headBefore },
        deliveryId: `dlv-ci-headsha-${randomBytes(6).toString("hex")}`,
      });
      await waitForCursor(
        harness,
        headOnly.seq,
        "the headSha-only CI-repair job and cursor advance",
        JOB_TIMEOUT_MS,
      );
      const detail = diagnostics(harness, "after headSha-only ci.changed");
      expectCiRepair(harness, headBefore, fixture, detail);
      expect(worker.running, detail).toBe(true);
      expectNoSecretLeaks(harness);
    } catch (error) {
      failure = error;
    } finally {
      await release(owned, failure);
    }
    if (failure) throw failure;
  },
  240_000,
);
