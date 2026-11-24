import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeRelay } from "../../helpers/fake-relay";
import { checkedCommand } from "../../helpers/process";
import { writeRelayState } from "../../helpers/relay-state";
import type { FakeRelayRequest } from "../../helpers/fake-relay";
import { IMPLEMENTATION_COMMENT_MARKER } from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { FakeLinearTracker } from "../../providers/fake-linear";

/** Far longer than the test, so Mode 1 polling only runs its startup tick. */
const POLL_INTERVAL_SECONDS = 3600;
/** The acquirer's initial backoff (`BACKOFF_INITIAL_MS`); the shortest the code allows. */
const RELAY_FIRST_RETRY = /\[relay\] poll failed \(retrying in 5s\): relay returned HTTP 503/;

function redact(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    redacted = redacted.replaceAll(secret, "[redacted]");
    redacted = redacted.replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return redacted;
}

/**
 * Commit the Linear workflow states the task child applies.
 *
 * The task child reads `.devintern-code/settings.json` from its worktree cwd,
 * so the settings ride on the fixture repo's base branch. `prStatus` equals
 * `inProgressStatus` because the local bare remote exposes no code host, so
 * no PR (and no post-PR transition) is created.
 */
async function commitLinearSettings(
  worker: WorkerFixture,
  tracker: FakeLinearTracker,
): Promise<void> {
  const dir = join(worker.seed, ".devintern-code");
  mkdirSync(dir, { recursive: true });
  const settings = buildTrackerSettings("linear", tracker.projectKey(), {
    todoStatus: tracker.statuses.todo,
    inProgressStatus: tracker.statuses.inProgress,
    prStatus: tracker.statuses.inProgress,
  });
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  const git = (...args: string[]) => checkedCommand(["git", ...args], worker.seed, worker.env);
  // The fixture ignores `.devintern-code/`; force-track only the settings file.
  await git("add", "--force", ".devintern-code/settings.json");
  await git("commit", "-m", "Add Linear workflow settings");
  await git("push", "origin", worker.baseBranch);
}

function requestSummary(requests: readonly FakeRelayRequest[]): string {
  return JSON.stringify(
    requests.map((request) => ({
      cursor: request.cursor,
      authorized: request.authorized,
      status: request.status,
      delivered: request.delivered,
    })),
  );
}

test.skipIf(!existsSync(cliPath))(
  "worker runs a relayed Linear task.changed once, honors the query, resumes its cursor, and survives a relay outage",
  async () => {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const relayToken = `drt_e2e${nonce}`;
    const marker = `E2ERELAY${nonce}`;
    const taskQuery = JSON.stringify({ title: { containsIgnoreCase: marker } });

    // Every resource is recorded as soon as it exists so finally can release it.
    let relay: FakeRelay | undefined;
    let tracker: FakeLinearTracker | undefined;
    let worker: WorkerFixture | undefined;
    let failure: unknown;
    try {
      relay = new FakeRelay({ token: relayToken, holdMs: 1_000 });
      tracker = new FakeLinearTracker();
      const fakeRelay = relay;
      const linear = tracker;
      const linearKey = linear.environment().LINEAR_API_KEY ?? "";
      const secrets = [relayToken, linearKey];

      worker = new WorkerFixture({
        tracker: "linear",
        // Comments stay on so the run's Linear comment is observable.
        workerTaskArgs: "--create-pr --skip-clarity-check",
        workspaceTomlExtra: [
          `task_query = ${JSON.stringify(taskQuery)}`,
          `poll_interval = ${POLL_INTERVAL_SECONDS}`,
        ].join("\n"),
        env: { ...linear.environment(), WORKER_RELAY_URL: fakeRelay.url },
      });
      const daemon = worker;
      const diagnostics = (detail = ""): string =>
        redact(
          [
            detail,
            `relay requests: ${requestSummary(fakeRelay.requests)}`,
            `relay unexpected: ${JSON.stringify(fakeRelay.unexpectedRequests)}`,
            `linear operations: ${JSON.stringify(linear.operations)}`,
            `linear unexpected: ${JSON.stringify(linear.unexpectedOperations)}`,
            `runs: ${JSON.stringify(daemon.runRecords())}`,
            `agent: ${JSON.stringify(daemon.agentInvocations())}`,
            daemon.tail(),
          ]
            .filter(Boolean)
            .join("\n"),
          secrets,
        );
      const waitForCursor = (cursor: string, label: string, from = 0) =>
        daemon.waitFor(
          label,
          () =>
            fakeRelay.requests.slice(from).some((request) => request.cursor === cursor)
              ? true
              : undefined,
          30_000,
        );

      // The decoy exists before startup but never matches task_query.
      const decoy = await linear.createTicket({
        title: "Expand the greeting (relay decoy)",
        body: "# Decoy\n\nOutside the worker query; the relay hint alone must not run it.\n",
      });

      await daemon.prepare();
      writeRelayState(daemon.workspaceDir, fakeRelay.url, relayToken);
      await commitLinearSettings(daemon, linear);

      daemon.start();
      await daemon.waitForReady();
      await daemon.waitForOutput(/Relay connected: .* \(Mode 2\)/, 20_000, "the relay acquirer");
      // Mode 1's startup tick must have read the tracker before the eligible
      // issue exists, so only the relay can be what triggers its run.
      await daemon.waitFor("the startup poll tick to query Linear", () =>
        linear.operations.includes("SearchIssues") ? true : undefined,
      );
      await waitForCursor("0", "the first relay long poll from cursor 0");
      expect(daemon.runRecords(), diagnostics()).toEqual([]);

      const issue = await linear.createTicket({
        title: `Expand the greeting ${marker}`,
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
      });
      const branch = `feature/${issue.key.toLowerCase()}`;
      const decoyEnvelope = fakeRelay.publishTaskChanged({
        task: decoy.key,
        source: "linear",
        deliveryId: `dlv-decoy-${nonce}`,
      });
      const deliveryId = `dlv-task-${nonce}`;
      const taskEnvelope = fakeRelay.publishTaskChanged({
        task: issue.key,
        source: "linear",
        deliveryId,
      });
      expect([decoyEnvelope.seq, taskEnvelope.seq]).toEqual([1, 2]);

      const run = await daemon.waitFor(
        `a terminal run for ${issue.key}`,
        () =>
          daemon
            .runRecords(issue.key)
            .find((record) => record.status !== "in_progress" && record.finished_at !== null),
        90_000,
      );
      // The cursor only advances past an envelope after its dispatch settles.
      await waitForCursor(String(taskEnvelope.seq), "the poll after the task envelope");
      const delivered = diagnostics();

      expect(run.status, delivered).toBe("succeeded");
      expect(run.branch, delivered).toBe(branch);
      expect(daemon.runRecords(), delivered).toHaveLength(1);
      expect(daemon.agentInvocations(), delivered).toEqual([{ mode: "implement" }]);
      expect(await daemon.remoteBranches(), delivered).toContain(branch);
      expect(await daemon.branchFile(branch, "src/greeting.ts"), delivered).toBe(
        'export const greeting = "Hello, world!";',
      );
      expect(await linear.getStatus(issue.key), delivered).toBe(linear.statuses.inProgress);
      const comments = await linear.listComments(issue.key);
      expect(
        comments.filter((comment) => comment.body.includes(IMPLEMENTATION_COMMENT_MARKER)),
        delivered,
      ).toHaveLength(1);
      expect(daemon.logs, delivered).toContain(`[fleet] relay task ${issue.key} is ready`);
      expect(daemon.logs, delivered).not.toContain(`[fleet] relay task ${decoy.key} is ready`);

      // The decoy hint was dispatched (the cursor moved past it) but the query
      // decided: no run, branch, comment, or state change.
      expect(daemon.runRecords(decoy.key), delivered).toEqual([]);
      expect(await daemon.remoteBranches(), delivered).not.toContain(
        `feature/${decoy.key.toLowerCase()}`,
      );
      expect(await linear.listComments(decoy.key), delivered).toEqual([]);
      expect(await linear.getStatus(decoy.key), delivered).toBe(linear.statuses.todo);

      // A redelivery of the same deliveryId under a new seq is acknowledged
      // without a second run.
      const replay = fakeRelay.publishTaskChanged({
        task: issue.key,
        source: "linear",
        deliveryId,
      });
      await waitForCursor(String(replay.seq), "the poll after the replayed delivery");
      const replayed = diagnostics();
      expect(daemon.runRecords(), replayed).toHaveLength(1);
      expect(daemon.agentInvocations(), replayed).toEqual([{ mode: "implement" }]);
      expect(daemon.logs.match(/\[fleet\] relay task .* is ready/g) ?? [], replayed).toHaveLength(
        1,
      );

      // Graceful restart with a scripted outage on the first poll: the new
      // daemon resumes the persisted cursor (not 0), logs the failure, backs
      // off, and retries with the same cursor instead of crashing.
      await daemon.stop();
      const restartFrom = fakeRelay.requestCount;
      fakeRelay.failNext(1);
      daemon.start();
      await daemon.waitForReady();
      await daemon.waitForOutput(RELAY_FIRST_RETRY, 20_000, "the relay outage warning");
      await daemon.waitFor(
        "the relay retry after the outage",
        () => (fakeRelay.requests.length >= restartFrom + 2 ? true : undefined),
        20_000,
      );
      const restarted = diagnostics();
      const [outage, retry] = fakeRelay.requests.slice(restartFrom);
      expect(outage, restarted).toMatchObject({ cursor: String(replay.seq), status: 503 });
      expect(retry?.cursor, restarted).toBe(String(replay.seq));
      expect(
        fakeRelay.requests.slice(restartFrom).some((request) => request.cursor === "0"),
        restarted,
      ).toBe(false);
      expect(daemon.running, restarted).toBe(true);

      // Delivery recovers after the outage: a later envelope is consumed.
      const afterOutage = fakeRelay.publishTaskChanged({
        task: decoy.key,
        source: "linear",
        deliveryId: `dlv-decoy-again-${nonce}`,
      });
      await waitForCursor(String(afterOutage.seq), "the poll after recovery", restartFrom);
      const recovered = diagnostics();
      expect(daemon.runRecords(), recovered).toHaveLength(1);
      expect(daemon.agentInvocations(), recovered).toEqual([{ mode: "implement" }]);
      expect(daemon.running, recovered).toBe(true);

      // Every poll carried the bearer token; neither it nor the fake tracker
      // key ever reached the worker's output.
      expect(
        fakeRelay.requests.every((request) => request.authorized),
        recovered,
      ).toBe(true);
      for (const secret of secrets) {
        expect(daemon.logs.includes(secret), "worker logs contain a credential").toBe(false);
        expect(
          daemon.logs.includes(encodeURIComponent(secret)),
          "worker logs contain an encoded credential",
        ).toBe(false);
      }
      expect(fakeRelay.unexpectedRequests, recovered).toEqual([]);
      expect(linear.unexpectedOperations, recovered).toEqual([]);
    } catch (error) {
      failure = error;
    } finally {
      const residue: string[] = [];
      const attempt = async (label: string, step: () => Promise<void> | undefined) => {
        try {
          await step();
        } catch (error) {
          residue.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      // Stop the worker first so it is not polling a relay that just vanished.
      await attempt("worker fixture", () => worker?.dispose());
      await attempt("fake relay", () => relay?.cleanup());
      await attempt("fake Linear server", () => tracker?.cleanup());
      if (residue.length > 0) {
        const residueError = new Error(
          redact(`Cleanup left residue:\n${residue.join("\n")}`, [relayToken]),
        );
        if (failure) {
          console.error(residueError.message);
        } else {
          failure = residueError;
        }
      }
    }
    if (failure) throw failure;
  },
  // Two bounded worker starts, one implementation run, and one 5s relay backoff.
  150_000,
);
