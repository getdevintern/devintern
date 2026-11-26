import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { FAKE_RELAY_WORKER_ID, FakeRelay } from "../../helpers/fake-relay";
import { relayStatePath, writeRelayState } from "../../helpers/relay-state";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { FakeLinearTracker } from "../../providers/fake-linear";

/** Far longer than the test, so Mode 1 polling only runs its startup tick. */
const POLL_INTERVAL_SECONDS = 3600;

/**
 * Start a Linear worker (whose query matches nothing) against `relay`, and
 * return it once its first relay poll arrived.
 */
async function startWorker(
  relay: FakeRelay,
  linear: FakeLinearTracker,
  relayToken: string,
): Promise<WorkerFixture> {
  const worker = new WorkerFixture({
    tracker: "linear",
    workerTaskArgs: "--skip-clarity-check",
    workspaceTomlExtra: [
      `task_query = ${JSON.stringify(JSON.stringify({ title: { containsIgnoreCase: "NO-MATCH" } }))}`,
      `poll_interval = ${POLL_INTERVAL_SECONDS}`,
    ].join("\n"),
    env: { ...linear.environment(), WORKER_RELAY_URL: relay.url },
  });
  await worker.prepare();
  writeRelayState(worker.workspaceDir, relay.url, relayToken);
  worker.start();
  await worker.waitForReady();
  await worker.waitForOutput(/Relay connected: .* \(Mode 2\)/, 20_000, "the relay acquirer");
  await worker.waitFor("the first relay long poll", () =>
    relay.requests.length > 0 ? true : undefined,
  );
  return worker;
}

test.skipIf(!existsSync(cliPath))(
  "a worker with a new relay identity starts at the relay head instead of replaying history",
  async () => {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const relayToken = `drt_e2e${nonce}`;
    const relay = new FakeRelay({ token: relayToken, holdMs: 500, startAtHead: true });
    const linear = new FakeLinearTracker();
    let worker: WorkerFixture | undefined;
    try {
      for (const index of [1, 2, 3]) {
        relay.publishTaskChanged({
          task: `HIST-${index}`,
          source: "linear",
          deliveryId: `dlv-history-${index}-${nonce}`,
        });
      }
      worker = await startWorker(relay, linear, relayToken);
      const daemon = worker;
      const diagnostics = () =>
        [
          `relay requests: ${JSON.stringify(relay.requests)}`,
          `registrations: ${JSON.stringify(relay.registrations)}`,
          `relay unexpected: ${JSON.stringify(relay.unexpectedRequests)}`,
          daemon.tail(),
        ].join("\n");

      expect(relay.registrations, diagnostics()).toHaveLength(1);
      expect(relay.registrations[0], diagnostics()).toMatchObject({
        authorized: true,
        workerId: null,
        cursor: 3,
      });
      expect(relay.registrations[0]?.label, diagnostics()).toMatch(/:ws-[0-9a-f]{8}$/);
      expect(relay.requests[0]?.cursor, diagnostics()).toBe("3");
      expect(
        relay.requests.some((request) => request.cursor === "0"),
        diagnostics(),
      ).toBe(false);

      // The identity and its start cursor persist owner-only, without exposing the token elsewhere.
      const statePath = relayStatePath(daemon.workspaceDir);
      const state = JSON.parse(readFileSync(statePath, "utf8")) as {
        worker?: { workerId: string; startCursor: number; label: string };
      };
      expect(state.worker, diagnostics()).toMatchObject({
        workerId: FAKE_RELAY_WORKER_ID,
        startCursor: 3,
      });
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
      expect(daemon.logs, diagnostics()).not.toContain(relayToken);

      // New events after the head still arrive.
      relay.publishTaskChanged({ task: "NEW-1", source: "linear", deliveryId: `dlv-new-${nonce}` });
      await daemon.waitFor(
        "the poll after the new envelope",
        () => (relay.requests.some((request) => request.cursor === "4") ? true : undefined),
        30_000,
      );
      expect(daemon.logs, diagnostics()).not.toContain("HIST-");
      expect(relay.unexpectedRequests, diagnostics()).toEqual([]);
    } finally {
      await worker?.dispose();
      await relay.cleanup();
      await linear.cleanup();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "against a relay without worker identities the worker keeps account-level delivery from cursor 0",
  async () => {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const relayToken = `drt_e2e${nonce}`;
    const relay = new FakeRelay({ token: relayToken, holdMs: 500, legacy: true });
    const linear = new FakeLinearTracker();
    let worker: WorkerFixture | undefined;
    try {
      relay.publishTaskChanged({ task: "OLD-1", source: "linear", deliveryId: `dlv-old-${nonce}` });
      worker = await startWorker(relay, linear, relayToken);
      const daemon = worker;
      expect(relay.requests[0]?.cursor, daemon.tail()).toBe("0");
      expect(relay.unexpectedRequests, daemon.tail()).toEqual([]);
      const state = JSON.parse(readFileSync(relayStatePath(daemon.workspaceDir), "utf8")) as {
        worker?: unknown;
      };
      expect(state.worker).toBeUndefined();
    } finally {
      await worker?.dispose();
      await relay.cleanup();
      await linear.cleanup();
    }
  },
  120_000,
);
