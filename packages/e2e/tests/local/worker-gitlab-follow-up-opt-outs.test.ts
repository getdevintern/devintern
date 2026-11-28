/**
 * GitLab follow-up opt-outs on a real `devintern worker`, offline.
 *
 * `[workspace].conflict_resolution = "disabled"` and
 * `[workspace].ci_failure_fix = false` are the kill switches for automatic
 * pushes to the agent's own MRs. Each case runs the built CLI against a
 * loopback {@link FakeGitlabForge}, a local bare repository (git fetch/push
 * are rewritten onto it), the deterministic agent, and a refusing
 * {@link startRecordingProxy} egress proxy.
 *
 * - Poll ticks (`poll_interval = 1`): a registered MR that conflicts with its
 *   target is left alone while conflict resolution is disabled, then resolved
 *   once after a live switch to `"auto"` (the positive control).
 * - Poll ticks: a failed pipeline on the registered MR's head runs no CI
 *   repair while `ci_failure_fix = false`, runs exactly one after a live
 *   switch to `true` (the positive control), and runs nothing for a new failed
 *   head after a live switch back to `false`.
 * - Relay hints (`poll_interval` of an hour): `change.changed` and
 *   `ci.changed` for the registered MR run nothing while both are off. A
 *   later `change.changed` after a live switch to `"auto"` resolves the MR.
 *   The `ci.changed` positive control is in `worker-relay-gitlab-events.test.ts`.
 *
 * "Several poll ticks" is an observable, not a sleep: every registered-MR
 * poll reads `merge_requests/1/discussions` from the forge, so the tests wait
 * for N more of those reads.
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FakeGitlabForge } from "../../helpers/fake-gitlab-forge";
import type { FakeGitlabCiFailure } from "../../helpers/fake-gitlab-forge";
import { FakeRelay } from "../../helpers/fake-relay";
import type { FakeRelayCodeHostIdentity } from "../../helpers/fake-relay";
import {
  gitPushLines,
  installGitlabGitRewrite,
  registerGitlabMergeRequest,
} from "../../helpers/gitlab-worker-follow-up";
import { checkedCommand } from "../../helpers/process";
import { proxyEnvironment, startRecordingProxy } from "../../helpers/recording-proxy";
import type { RecordingProxy } from "../../helpers/recording-proxy";
import { relayStatePath, writeRelayState } from "../../helpers/relay-state";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { randomToken } from "../../helpers/worker-doctor";

const cliTest = test.skipIf(!existsSync(cliPath));

const PROJECT_PATH = "fixture/repo";
const AGENT_BRANCH = "devintern/e2e-1-greeting";
const FEEDBACK_SOURCE = "gitlab:registered-mr-feedback";
const WORLD_GREETING = 'export const greeting = "Hello, world!";\n';
const BRANCH_GREETING = 'export const greeting = "Hello, branch!";\n';
const BASE_GREETING = 'export const greeting = "Hello, base!";\n';
const MERGED_GREETING = 'export const greeting = "Hello, merged!";\n';
const CI_GREETING = 'export const greeting = "Hello, CI!";\n';
const PIPELINE_ID = 3001;
const JOB_ID = 4001;
/** Registered-MR poll ticks observed while an opt-out must hold. */
const QUIET_TICKS = 4;
const JOB_TIMEOUT_MS = 150_000;
const RELOAD_LINE = "🔄 [config] Reloaded";

type ConflictMode = "auto" | "disabled";

interface Scenario {
  /** `conflict`: the MR branch and its target change the same line. `review`: the MR is mergeable. */
  seed: "conflict" | "review";
  /** Serve a failed pipeline for the MR branch's seeded head. */
  ci: boolean;
  conflictResolution: ConflictMode;
  ciFailureFix: boolean;
  /** Long-poll a {@link FakeRelay} and set `poll_interval` to an hour; otherwise poll every second. */
  relay: boolean;
}

interface Harness {
  worker: WorkerFixture;
  forge: FakeGitlabForge;
  egress: RecordingProxy;
  relay?: FakeRelay;
  gitBin: string;
  gitLog: string;
  codeHost: FakeRelayCodeHostIdentity;
  secrets: string[];
  /** MR branch tip before the worker started. */
  headSha: string;
  /** Target branch tip before the worker started. */
  baseSha: string;
  markers?: { jobMarker: string; traceMarker: string };
}

/** Everything a test created, released in `finally` even after a failure. */
interface Owned {
  worker?: WorkerFixture;
  forge?: FakeGitlabForge;
  relay?: FakeRelay;
  egress?: RecordingProxy;
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

function parents(gitBin: string, gitDir: string, rev: string): string[] {
  return gitOutput(gitBin, gitDir, ["rev-list", "--parents", "-n", "1", rev]).split(/\s+/).slice(1);
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

function processedSyncs(dbPath: string): string[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    return (
      db
        .query("SELECT external_id FROM processed_events WHERE source = ?")
        .all(FEEDBACK_SOURCE) as Array<{ external_id: string }>
    )
      .map((row) => row.external_id)
      .filter((id) => id.startsWith("sync:"));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Registered-MR poll reads: one per poller tick or relay reconcile of MR !1. */
function snapshotReads(forge: FakeGitlabForge): number {
  return forge.requests.filter(
    (request) =>
      request.method === "GET" && /\/merge_requests\/1\/discussions(?:\?|$)/.test(request.path),
  ).length;
}

/** Pipeline, job, trace, and commit-status reads, from request index `from` on. */
function ciRequests(forge: FakeGitlabForge, from = 0): string[] {
  return forge.requests
    .slice(from)
    .map((request) => request.path)
    .filter((path) => /\/(pipelines|jobs|statuses)(\/|\?|$)/.test(path));
}

function reloadCount(worker: WorkerFixture): number {
  return worker.logs.split(RELOAD_LINE).length - 1;
}

function ciFixRuns(worker: WorkerFixture) {
  return worker.runRecords().filter((run) => run.origin === "ci_fix");
}

/** A failed job whose name and trace each carry a unique prompt marker. */
function ciFailure(): {
  markers: { jobMarker: string; traceMarker: string };
  ci: Omit<FakeGitlabCiFailure, "sha">;
} {
  const jobMarker = `E2EPROMPTMARKERJOB${randomBytes(6).toString("hex").toUpperCase()}`;
  const traceMarker = `E2EPROMPTMARKERTRACE${randomBytes(6).toString("hex").toUpperCase()}`;
  return {
    markers: { jobMarker, traceMarker },
    ci: {
      pipelineId: PIPELINE_ID,
      jobId: JOB_ID,
      jobName: `unit-${jobMarker}`,
      // E2E_CI_FIX_MARKER selects the deterministic agent's CI-repair mode.
      trace: `$ bun test\nE2E_CI_FIX_MARKER greeting assertion failed ${traceMarker}\nJob failed: exit code 1\n`,
    },
  };
}

async function seedBranches(
  worker: WorkerFixture,
  gitBin: string,
  seed: Scenario["seed"],
): Promise<void> {
  const git = (...args: string[]) => checkedCommand([gitBin, ...args], worker.seed, worker.env);
  await git("checkout", "-b", AGENT_BRANCH);
  writeFileSync(
    join(worker.seed, "src/greeting.ts"),
    seed === "conflict" ? BRANCH_GREETING : WORLD_GREETING,
  );
  await git("commit", "-am", seed === "conflict" ? "Branch greeting" : "Implement greeting");
  await git("push", "origin", AGENT_BRANCH);
  await git("checkout", worker.baseBranch);
  if (seed !== "conflict") return;
  writeFileSync(join(worker.seed, "src/greeting.ts"), BASE_GREETING);
  await git("commit", "-am", "Base greeting");
  await git("push", "origin", worker.baseBranch);
}

/** Point the repo at the forge URL and write both follow-up policies. */
function patchWorkspace(worker: WorkerFixture, remoteUrl: string, scenario: Scenario): void {
  const path = join(worker.workspaceDir, "workspace.toml");
  const remoteLine = `remote = "${worker.remote}"`;
  let text = readFileSync(path, "utf8");
  if (!text.includes(remoteLine) || !text.includes("[workspace]\ndashboard = false\n")) {
    throw new Error("generated workspace.toml did not have the expected shape");
  }
  text = text.replace(remoteLine, `remote = "${remoteUrl}"`);
  text = text.replace(
    "[workspace]\ndashboard = false\n",
    `[workspace]\ndashboard = false\nci_failure_fix = ${scenario.ciFailureFix}\n` +
      `conflict_resolution = "${scenario.conflictResolution}"\n`,
  );
  writeFileSync(path, text);
}

/**
 * Rewrite one `[workspace]` line on the running worker and wait for the live
 * reloader to apply it. A rejected reload never logs the line, so the wait
 * fails with the worker log instead of passing on the old config.
 */
async function setWorkspaceLine(
  harness: Harness,
  current: string,
  next: string,
  label: string,
): Promise<void> {
  const path = join(harness.worker.workspaceDir, "workspace.toml");
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  if (lines.filter((line) => line === current).length !== 1) {
    throw new Error(`workspace.toml has no single line ${current}`);
  }
  const before = reloadCount(harness.worker);
  writeFileSync(path, lines.map((line) => (line === current ? next : line)).join("\n"));
  await harness.worker.waitFor(
    `the live reload to ${label}`,
    () => (reloadCount(harness.worker) > before ? true : undefined),
    20_000,
  );
}

/** Wait for `count` more registered-MR poll reads than there are now. */
async function waitForPollTicks(harness: Harness, count: number, label: string): Promise<void> {
  const start = snapshotReads(harness.forge);
  await harness.worker.waitFor(
    label,
    () => (snapshotReads(harness.forge) >= start + count ? true : undefined),
    30_000,
  );
}

/** Wait until the worker long-polls the relay from `seq` (its dispatch has settled). */
function waitForCursor(harness: Harness, seq: number, label: string, timeoutMs = 30_000) {
  const relay = harness.relay;
  if (!relay) throw new Error("this harness has no relay");
  return harness.worker.waitFor(
    label,
    () => (relay.requests.some((request) => request.cursor === String(seq)) ? true : undefined),
    timeoutMs,
  );
}

function agentRuns(worker: WorkerFixture): Array<{ mode: string; promptMarkers?: string[] }> {
  return worker.agentInvocations() as Array<{ mode: string; promptMarkers?: string[] }>;
}

/**
 * `worker runs --json` through the built CLI. Its output must carry no
 * credential either.
 */
async function cliRuns(harness: Harness): Promise<Array<{ id: number; status: string }>> {
  const result = await harness.worker.runCli(["worker", "runs", "--json"]);
  const output = `${result.stdout}\n${result.stderr}`;
  for (const secret of harness.secrets) {
    expect(output.includes(secret), "worker runs output contains a credential").toBe(false);
    expect(output.includes(encodeURIComponent(secret))).toBe(false);
  }
  if (result.exitCode !== 0) {
    throw new Error(`worker runs --json exited ${result.exitCode}:\n${result.stderr}`);
  }
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}";
  const parsed = JSON.parse(line) as { runs?: Array<{ id: number; status: string }> };
  return parsed.runs ?? [];
}

function diagnostics(harness: Harness, detail = ""): string {
  const { worker, forge, relay, egress } = harness;
  return redact(
    [
      detail,
      `forge requests: ${JSON.stringify(forge.requests)}`,
      `forge unexpected: ${JSON.stringify(forge.unexpected)}`,
      `forge auth failures: ${JSON.stringify(forge.authFailures)}`,
      `notes: ${forge.notes.length}`,
      `agent: ${JSON.stringify(agentRuns(worker))}`,
      `pushes: ${JSON.stringify(gitPushLines(harness.gitLog))}`,
      `runs: ${JSON.stringify(worker.runRecords().map((run) => [run.origin, run.status]))}`,
      `egress: ${JSON.stringify(egress.requests())}`,
      relay ? `relay requests: ${JSON.stringify(relay.requests)}` : "",
      worker.tail(),
    ]
      .filter(Boolean)
      .join("\n"),
    harness.secrets,
  );
}

/** Nothing ran: no agent, no push, no forge write, both tips where they were seeded. */
function expectNothingRan(harness: Harness, detail: string): void {
  const { worker, forge, gitBin } = harness;
  expect(agentRuns(worker), detail).toEqual([]);
  expect(gitPushLines(harness.gitLog), detail).toEqual([]);
  expect(forge.mutations(), detail).toEqual([]);
  expect(forge.notes, detail).toEqual([]);
  expect(revParse(gitBin, worker.remote, AGENT_BRANCH), detail).toBe(harness.headSha);
  expect(revParse(gitBin, worker.remote, worker.baseBranch), detail).toBe(harness.baseSha);
  expect(processedSyncs(worker.dbPath), detail).toEqual([]);
  expect(worker.runRecords(), detail).toEqual([]);
  expect(forge.unexpected, detail).toEqual([]);
  expect(forge.authFailures, detail).toEqual([]);
}

/** One merge commit of the old head and the target, pushed as a fast-forward. */
function expectConflictResolvedOnce(harness: Harness, detail: string): void {
  const { worker, forge, gitBin } = harness;
  expect(agentRuns(worker), detail).toEqual([{ mode: "conflict" }]);
  expect(showFile(gitBin, worker.remote, AGENT_BRANCH, "src/greeting.ts"), detail).toBe(
    MERGED_GREETING,
  );
  const head = revParse(gitBin, worker.remote, AGENT_BRANCH);
  expect(parents(gitBin, worker.remote, head), detail).toEqual([harness.headSha, harness.baseSha]);
  expect(revParse(gitBin, worker.remote, worker.baseBranch), detail).toBe(harness.baseSha);
  expect(mergeTreeStatus(gitBin, worker.remote, worker.baseBranch, AGENT_BRANCH), detail).toBe(0);
  expect(gitPushLines(harness.gitLog), detail).toEqual([`push origin ${AGENT_BRANCH}`]);
  expect(
    forge.mutations().every((request) => /\/merge_requests\/1\/notes(?:\?|$)/.test(request.path)),
    detail,
  ).toBe(true);
  expect(forge.unexpected, detail).toEqual([]);
  expect(forge.authFailures, detail).toEqual([]);
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
 * No request left the machine, and no credential (raw or URL-encoded) reached
 * worker output, a forge note, or any file the run wrote. The seeded relay
 * pairing file is the one place the relay token is expected.
 */
function expectContained(harness: Harness): void {
  const { worker, forge, egress, secrets } = harness;
  expect(egress.requests(), diagnostics(harness, "egress")).toEqual([]);
  const pairing = relayStatePath(worker.workspaceDir);
  for (const secret of secrets) {
    for (const form of [secret, encodeURIComponent(secret)]) {
      expect(worker.logs.includes(form), "worker output contains a credential").toBe(false);
      expect(
        forge.notes.some((note) => note.includes(form)),
        "a forge note contains a credential",
      ).toBe(false);
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

/**
 * Build the egress proxy, forge, optional relay, and worker; seed the
 * branches; start the worker and wait until its GitLab acquirers have started
 * over an empty registry. The caller registers the MR.
 */
async function openHarness(owned: Owned, scenario: Scenario): Promise<Harness> {
  const gitBin = Bun.which("git");
  if (!gitBin) throw new Error("git is required for the GitLab follow-up fixture");
  const forgeToken = randomToken("glpat-e2e-");
  const relayToken = scenario.relay ? randomToken("drt_e2e") : undefined;
  const secrets = relayToken ? [forgeToken, relayToken] : [forgeToken];
  const pollInterval = scenario.relay ? 3600 : 1;

  const egress = await startRecordingProxy();
  owned.egress = egress;
  const relay = relayToken ? new FakeRelay({ token: relayToken, holdMs: 1_000 }) : undefined;
  owned.relay = relay;
  const worker = new WorkerFixture({
    rootPrefix: "devintern-e2e-gitlab-opt-out-",
    // A disabled automation is the configured work that keeps the worker up.
    automations: [
      {
        id: "keep-alive",
        enabled: false,
        prompt: "This disabled automation only keeps the workspace worker alive.",
        cron: "0 0 1 1 *",
      },
    ],
    workspaceTomlExtra: `poll_interval = ${pollInterval}`,
    env: {
      ...proxyEnvironment(egress.url),
      ...(relay ? { WORKER_RELAY_URL: relay.url } : {}),
    },
  });
  owned.worker = worker;
  await worker.prepare();
  await seedBranches(worker, gitBin, scenario.seed);
  const headSha = revParse(gitBin, worker.remote, AGENT_BRANCH);
  const baseSha = revParse(gitBin, worker.remote, worker.baseBranch);
  const failure = scenario.ci ? ciFailure() : undefined;

  const forge = new FakeGitlabForge({
    gitDir: worker.remote,
    gitBin,
    sourceBranch: AGENT_BRANCH,
    targetBranch: worker.baseBranch,
    token: forgeToken,
    ...(failure ? { ci: { ...failure.ci, sha: headSha } } : {}),
  });
  owned.forge = forge;

  const remoteUrl = `${forge.baseUrl}/${PROJECT_PATH}.git`;
  Object.assign(worker.env, {
    DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
    GITLAB_CODE_HOST_URL: forge.baseUrl,
    GITLAB_CODE_HOST_TOKEN: forgeToken,
    DEVINTERN_REVIEW_WORKTREE_PATH: join(worker.root, "review-worktree"),
  });
  const gitLog = installGitlabGitRewrite(worker, gitBin, remoteUrl);
  patchWorkspace(worker, remoteUrl, scenario);
  if (relay && relayToken) writeRelayState(worker.workspaceDir, relay.url, relayToken);

  const harness: Harness = {
    worker,
    forge,
    egress,
    relay,
    gitBin,
    gitLog,
    codeHost: {
      provider: "gitlab",
      instanceUrl: forge.baseUrl,
      projectId: "1",
      projectPath: PROJECT_PATH,
    },
    secrets,
    headSha,
    baseSha,
    ...(failure ? { markers: failure.markers } : {}),
  };

  worker.start();
  await worker.waitForReady();
  await worker.waitForOutput(
    new RegExp(`Polling reviews on 0 registered GitLab MR\\(s\\) every ${pollInterval}s`),
    20_000,
    "the GitLab registered-MR poller",
  );
  await worker.waitForOutput(
    new RegExp(`CI failure fixes ${scenario.ciFailureFix ? "enabled" : "disabled"}; `),
    20_000,
    "the CI failure watcher",
  );
  if (relay) {
    await worker.waitForOutput(/Relay connected: .* \(Mode 2\)/, 20_000, "the relay acquirer");
    await waitForCursor(harness, 0, "the first relay long poll from cursor 0");
  }
  return harness;
}

function registerMergeRequest(harness: Harness): void {
  registerGitlabMergeRequest(harness.worker, {
    instanceUrl: harness.codeHost.instanceUrl,
    projectPath: PROJECT_PATH,
    branch: AGENT_BRANCH,
  });
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
  await attempt("fake GitLab forge", () => owned.forge?.stop());
  await attempt("egress proxy", () => owned.egress?.close());
  if (root && existsSync(root)) residue.push(`temp root ${root} was not removed`);
  if (residue.length === 0) return;
  const message = `Cleanup left residue:\n${residue.join("\n")}`;
  if (failure) console.error(message);
  else throw new Error(message);
}

cliTest(
  'conflict_resolution = "disabled" leaves a conflicting registered MR alone across poll ticks; a live switch to "auto" resolves it',
  async () => {
    const owned: Owned = {};
    let failure: unknown;
    try {
      const harness = await openHarness(owned, {
        seed: "conflict",
        ci: false,
        conflictResolution: "disabled",
        ciFailureFix: false,
        relay: false,
      });
      const { worker, gitBin } = harness;
      expect(mergeTreeStatus(gitBin, worker.remote, worker.baseBranch, AGENT_BRANCH)).toBe(1);
      registerMergeRequest(harness);

      await waitForPollTicks(harness, QUIET_TICKS, "registered-MR poll ticks while disabled");
      const quiet = diagnostics(harness, "after poll ticks with conflict resolution disabled");
      // The poller saw the conflict on every tick (the forge reports it) and
      // still ran nothing.
      expectNothingRan(harness, quiet);
      expect(await cliRuns(harness), quiet).toEqual([]);

      // Positive control in the same harness: the setting applies on reload.
      await setWorkspaceLine(
        harness,
        'conflict_resolution = "disabled"',
        'conflict_resolution = "auto"',
        'conflict_resolution = "auto"',
      );
      await worker.waitFor(
        "conflict resolution after the switch to auto",
        () =>
          showFile(gitBin, worker.remote, AGENT_BRANCH, "src/greeting.ts") === MERGED_GREETING
            ? true
            : undefined,
        JOB_TIMEOUT_MS,
      );
      await worker.waitFor("the conflict sync to be marked processed", () =>
        processedSyncs(worker.dbPath).length > 0 ? true : undefined,
      );
      const resolved = diagnostics(harness, "after the switch to auto");
      expectConflictResolvedOnce(harness, resolved);
      // GitLab conflict resolution records no run; the processed sync id is
      // its outcome record (see worker-conflict-failover.test.ts).
      expect(await cliRuns(harness), resolved).toEqual([]);
      expect(worker.running, resolved).toBe(true);
      expectContained(harness);
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
  "ci_failure_fix = false runs no CI repair for a failed pipeline on the registered MR head; live reload turns it on and off",
  async () => {
    const owned: Owned = {};
    let failure: unknown;
    try {
      const harness = await openHarness(owned, {
        seed: "review",
        ci: true,
        conflictResolution: "auto",
        ciFailureFix: false,
        relay: false,
      });
      const { worker, forge, gitBin } = harness;
      const markers = harness.markers!;
      registerMergeRequest(harness);

      await waitForPollTicks(harness, QUIET_TICKS, "registered-MR poll ticks while CI fix is off");
      const quiet = diagnostics(harness, "after poll ticks with ci_failure_fix = false");
      expect(ciRequests(forge), quiet).toEqual([]);
      expectNothingRan(harness, quiet);
      expect(await cliRuns(harness), quiet).toEqual([]);

      // Positive control in the same harness: the next CI watcher tick reads
      // the failed pipeline and runs exactly one repair.
      await setWorkspaceLine(
        harness,
        "ci_failure_fix = false",
        "ci_failure_fix = true",
        "ci_failure_fix = true",
      );
      await worker.waitFor(
        "the CI repair commit after the switch to true",
        () =>
          showFile(gitBin, worker.remote, AGENT_BRANCH, "src/greeting.ts") === CI_GREETING
            ? true
            : undefined,
        JOB_TIMEOUT_MS,
      );
      await worker.waitFor("the CI repair run to settle", () => {
        const runs = ciFixRuns(worker);
        return runs.length === 1 && runs[0]?.finished_at ? true : undefined;
      });
      const repaired = diagnostics(harness, "after the switch to true");
      const runs = agentRuns(worker);
      expect(runs, repaired).toHaveLength(1);
      expect(runs[0]?.mode, repaired).toBe("ci");
      // The failed job name and trace reached the prompt only via the forge.
      expect(runs[0]?.promptMarkers ?? [], repaired).toContain(markers.jobMarker);
      expect(runs[0]?.promptMarkers ?? [], repaired).toContain(markers.traceMarker);
      const headAfter = revParse(gitBin, worker.remote, AGENT_BRANCH);
      expect(parents(gitBin, worker.remote, headAfter), repaired).toEqual([harness.headSha]);
      expect(gitPushLines(harness.gitLog), repaired).toHaveLength(1);
      expect(ciRequests(forge), repaired).toContain(
        `/api/v4/projects/1/pipelines?sha=${harness.headSha}&per_page=100&page=1`,
      );
      expect(ciRequests(forge), repaired).toContain(`/api/v4/projects/1/jobs/${JOB_ID}/trace`);
      expect(await cliRuns(harness), repaired).toHaveLength(1);

      // Live kill switch: back to false, then the repair commit fails CI too.
      await setWorkspaceLine(
        harness,
        "ci_failure_fix = true",
        "ci_failure_fix = false",
        "ci_failure_fix = false",
      );
      // Let a CI watcher tick that started before the reload finish first.
      await waitForPollTicks(harness, 2, "poll ticks after the switch back to false");
      const mutationsBefore = forge.mutations().length;
      const from = forge.requests.length;
      forge.setCiSha(headAfter);
      await waitForPollTicks(harness, QUIET_TICKS, "poll ticks with a failed repair head");
      const off = diagnostics(harness, "after the switch back to false");
      expect(ciRequests(forge, from), off).toEqual([]);
      expect(agentRuns(worker), off).toHaveLength(1);
      expect(revParse(gitBin, worker.remote, AGENT_BRANCH), off).toBe(headAfter);
      expect(gitPushLines(harness.gitLog), off).toHaveLength(1);
      expect(forge.mutations().length, off).toBe(mutationsBefore);
      expect(ciFixRuns(worker), off).toHaveLength(1);
      expect(forge.unexpected, off).toEqual([]);
      expect(forge.authFailures, off).toEqual([]);
      expect(worker.running, off).toBe(true);
      expectContained(harness);
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
  "relayed change.changed and ci.changed run nothing while conflict resolution and CI fix are off",
  async () => {
    const owned: Owned = {};
    let failure: unknown;
    try {
      const harness = await openHarness(owned, {
        seed: "conflict",
        ci: true,
        conflictResolution: "disabled",
        ciFailureFix: false,
        relay: true,
      });
      const { worker, forge, gitBin, codeHost } = harness;
      const relay = harness.relay!;
      expect(mergeTreeStatus(gitBin, worker.remote, worker.baseBranch, AGENT_BRANCH)).toBe(1);
      registerMergeRequest(harness);
      const nonce = randomBytes(6).toString("hex");
      const ref = { change: 1, branch: AGENT_BRANCH, headSha: harness.headSha };

      // The hint reaches the registered-MR poller, which reads the MR (and its
      // conflict) and still runs nothing.
      const readsBefore = snapshotReads(forge);
      const changed = relay.publishCodeHostEvent({
        eventType: "change.changed",
        source: "gitlab",
        codeHost,
        ref,
        deliveryId: `dlv-changed-off-${nonce}`,
      });
      await waitForCursor(harness, changed.seq, "the cursor past change.changed");
      const afterChanged = diagnostics(harness, "after change.changed with conflicts disabled");
      expect(snapshotReads(forge), afterChanged).toBeGreaterThan(readsBefore);
      expectNothingRan(harness, afterChanged);

      // The CI watcher ignores the hint before reading any pipeline.
      const ciChanged = relay.publishCiChanged({
        codeHost,
        ref,
        deliveryId: `dlv-ci-off-${nonce}`,
      });
      await waitForCursor(harness, ciChanged.seq, "the cursor past ci.changed");
      const afterCi = diagnostics(harness, "after ci.changed with CI fix off");
      expect(ciRequests(forge), afterCi).toEqual([]);
      expectNothingRan(harness, afterCi);
      expect(await cliRuns(harness), afterCi).toEqual([]);

      // Positive control for the conflict hint in the same harness.
      await setWorkspaceLine(
        harness,
        'conflict_resolution = "disabled"',
        'conflict_resolution = "auto"',
        'conflict_resolution = "auto"',
      );
      const again = relay.publishCodeHostEvent({
        eventType: "change.changed",
        source: "gitlab",
        codeHost,
        ref,
        deliveryId: `dlv-changed-auto-${nonce}`,
      });
      await waitForCursor(
        harness,
        again.seq,
        "the conflict job and cursor advance",
        JOB_TIMEOUT_MS,
      );
      const resolved = diagnostics(harness, "after change.changed with conflicts on auto");
      expectConflictResolvedOnce(harness, resolved);
      expect(ciRequests(forge), resolved).toEqual([]);
      expect(
        relay.requests.every((request) => request.authorized),
        resolved,
      ).toBe(true);
      expect(relay.unexpectedRequests, resolved).toEqual([]);
      expect(worker.running, resolved).toBe(true);
      expectContained(harness);
    } catch (error) {
      failure = error;
    } finally {
      await release(owned, failure);
    }
    if (failure) throw failure;
  },
  240_000,
);
