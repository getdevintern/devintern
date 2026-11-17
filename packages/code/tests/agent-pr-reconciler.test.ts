import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  agentPrKey,
  agentPrStateCursorSource,
  applyAgentPrFetch,
  reconcileOpenAgentPrs,
  resetUnusableStateWarnings,
} from "../src/lib/review/agent-pr-reconciler";
import type { ConditionalResult, PolledPr } from "../src/lib/review/agent-pr-reconciler";
import { WorkerState } from "../src/lib/state/worker-state";

describe("agent PR reconciler", () => {
  let dbPath: string;
  let workerState: WorkerState;

  beforeEach(() => {
    resetUnusableStateWarnings();
    dbPath = join(tmpdir(), `apr-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    workerState = new WorkerState(dbPath);
  });

  afterEach(() => {
    workerState.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  function open(result: Partial<PolledPr> = {}, etag = 'W/"1"'): ConditionalResult<PolledPr> {
    return { data: { state: "open", ...result }, etag, notModified: false };
  }

  test("a PR merged outside the worker is closed within one pass", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 7, branch: "feature/dev-1" });
    const summary = await reconcileOpenAgentPrs({
      workerState,
      github: {
        async fetchPr() {
          return { data: { state: "closed" }, etag: 'W/"2"', notModified: false };
        },
      },
      watched: workerState.listOpenAgentPrs(),
    });

    expect(summary.checked).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.closed).toEqual([{ repo: "acme/widgets", prNumber: 7, reason: "closed" }]);
    expect(workerState.listOpenAgentPrs()).toHaveLength(0);
    expect(workerState.countAgentPrs()).toEqual({ open: 0, closed: 1 });
  });

  test("a 404 leaves an inaccessible PR watched for a later retry", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 8 });
    const summary = await reconcileOpenAgentPrs({
      workerState,
      github: {
        async fetchPr() {
          return { data: null, notModified: false, gone: true };
        },
      },
      watched: workerState.listOpenAgentPrs(),
    });

    expect(summary.failed).toBe(1);
    expect(summary.closed).toEqual([]);
    expect(workerState.listOpenAgentPrs()).toHaveLength(1);
  });

  test("failures (rate limits, network) leave the row open", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 9 });
    const summary = await reconcileOpenAgentPrs({
      workerState,
      github: {
        async fetchPr() {
          throw new Error("GitHub API error (403): rate limit exceeded");
        },
      },
      watched: workerState.listOpenAgentPrs(),
    });

    expect(summary.checked).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.closed).toEqual([]);
    expect(workerState.listOpenAgentPrs()).toHaveLength(1);
  });

  test("a 304 (unchanged PR) keeps the row open at no extra state", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 10 });
    let calls = 0;
    const summary = await reconcileOpenAgentPrs({
      workerState,
      github: {
        async fetchPr() {
          calls += 1;
          return { data: null, notModified: true };
        },
      },
      watched: workerState.listOpenAgentPrs(),
    });

    expect(calls).toBe(1);
    expect(summary.closed).toEqual([]);
    expect(workerState.listOpenAgentPrs()).toHaveLength(1);
  });

  test("open PRs stay watched and their fetch results are shared via fresh", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 11 });
    const fresh = new Map<string, ConditionalResult<PolledPr>>();
    const summary = await reconcileOpenAgentPrs({
      workerState,
      github: {
        async fetchPr() {
          return open({ mergeable_state: "dirty" });
        },
      },
      watched: workerState.listOpenAgentPrs(),
      fresh,
    });

    expect(summary.closed).toEqual([]);
    expect(fresh.get(agentPrKey("acme/widgets", 11))?.data?.mergeable_state).toBe("dirty");
    expect(workerState.listOpenAgentPrs()).toHaveLength(1);
  });

  test("foreign repos are skipped when allowedRepos is set", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 12 });
    workerState.recordAgentPr({ repo: "other/widgets", prNumber: 13 });
    let checked: number[] = [];
    const summary = await reconcileOpenAgentPrs({
      workerState,
      github: {
        async fetchPr(_repo, n) {
          checked.push(n);
          return open();
        },
      },
      watched: workerState.listOpenAgentPrs(),
      allowedRepos: ["acme/widgets"],
    });

    expect(checked).toEqual([12]);
    expect(summary.checked).toBe(1);
    // The foreign row is left alone (startup pruning handles it).
    expect(workerState.listOpenAgentPrs("other/widgets")).toHaveLength(1);
  });

  test("stored ETags are sent and refreshed so steady-state syncs are conditional", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 14 });
    workerState.setCursor(agentPrStateCursorSource("acme/widgets", 14), "state", 'W/"old"');
    const seen: (string | undefined)[] = [];
    const summary = await reconcileOpenAgentPrs({
      workerState,
      github: {
        async fetchPr(_repo, _n, etag) {
          seen.push(etag);
          return open();
        },
      },
      watched: workerState.listOpenAgentPrs(),
    });

    expect(summary.failed).toBe(0);
    expect(seen).toEqual(['W/"old"']);
    expect(workerState.getCursor(agentPrStateCursorSource("acme/widgets", 14))?.etag).toBe('W/"1"');
  });

  test("applyAgentPrFetch persists the new ETag when the PR is still open", () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 15 });
    const closure = applyAgentPrFetch(workerState, { repo: "acme/widgets", prNumber: 15 }, open());

    expect(closure).toBeNull();
    expect(workerState.getCursor(agentPrStateCursorSource("acme/widgets", 15))?.etag).toBe('W/"1"');
  });

  test("an unusable PR state keeps the row open and clears the ETag cursor", () => {
    const payloads: { label: string; data: PolledPr; prNumber: number }[] = [
      { label: "missing state", data: {}, prNumber: 20 },
      { label: "undefined state", data: { state: undefined }, prNumber: 21 },
      { label: "null state", data: { state: null }, prNumber: 22 },
      { label: "empty state", data: { state: "" }, prNumber: 23 },
      { label: "unknown state", data: { state: "draft" }, prNumber: 24 },
      { label: "numeric state", data: { state: 42 }, prNumber: 25 },
      { label: "object state", data: { state: {} }, prNumber: 26 },
      { label: "boolean state", data: { state: true }, prNumber: 27 },
    ];

    payloads.forEach(({ label, data, prNumber }, index) => {
      workerState.recordAgentPr({ repo: "acme/widgets", prNumber });
      // Simulate a usable response from an earlier tick whose ETag must not
      // turn the retry into a state-less 304.
      workerState.setCursor(agentPrStateCursorSource("acme/widgets", prNumber), "state", 'W/"old"');
      const closure = applyAgentPrFetch(
        workerState,
        { repo: "acme/widgets", prNumber },
        { data, etag: 'W/"9"', notModified: false },
      );

      expect({ label, closure }).toEqual({ label, closure: null });
      expect({ label, open: workerState.listOpenAgentPrs("acme/widgets").length }).toEqual({
        label,
        open: index + 1,
      });
      expect({
        label,
        cursor: workerState.getCursor(agentPrStateCursorSource("acme/widgets", prNumber)),
      }).toEqual({ label, cursor: null });
      expect({ label, counts: workerState.countAgentPrs() }).toEqual({
        label,
        counts: { open: index + 1, closed: 0 },
      });
    });
  });

  test("an unusable response is re-read unconditionally instead of replayed as a 304", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 60 });
    // Minimal GitHub stand-in: same ETag, but the payload becomes usable
    // between ticks. Returning 304 whenever the client sends the ETag models
    // the failure the cursor clearing must prevent.
    let payload: PolledPr = {};
    const etag = 'W/"bad"';
    const sentEtags: (string | undefined)[] = [];
    let dataFetches = 0;
    const github = {
      async fetchPr(_repo: string, _prNumber: number, requestEtag?: string) {
        sentEtags.push(requestEtag);
        if (requestEtag === etag) return { data: null, notModified: true };
        dataFetches += 1;
        return { data: payload, etag, notModified: false };
      },
    };

    const first = await reconcileOpenAgentPrs({
      workerState,
      github,
      watched: workerState.listOpenAgentPrs(),
    });
    expect(first.closed).toEqual([]);
    expect(dataFetches).toBe(1);
    expect(workerState.getCursor(agentPrStateCursorSource("acme/widgets", 60))).toBeNull();

    // The same ETag now carries a usable state: only an unconditional request
    // can observe it.
    payload = { state: "open" };
    const second = await reconcileOpenAgentPrs({
      workerState,
      github,
      watched: workerState.listOpenAgentPrs(),
    });

    expect(sentEtags).toEqual([undefined, undefined]);
    expect(dataFetches).toBe(2);
    expect(second.closed).toEqual([]);
    expect(workerState.getCursor(agentPrStateCursorSource("acme/widgets", 60))?.etag).toBe(etag);
    expect(workerState.listOpenAgentPrs().map((pr) => pr.prNumber)).toEqual([60]);
  });

  test("an unusable PR state warns once per PR per process", () => {
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    try {
      workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 30 });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        applyAgentPrFetch(
          workerState,
          { repo: "acme/widgets", prNumber: 30 },
          { data: {}, etag: 'W/"1"', notModified: false },
        );
      }
    } finally {
      warn.mockRestore();
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("acme/widgets#30");
    expect(warnings[0]).not.toContain("undefined; unwatching");
  });

  test("a closed then re-registered PR warns again about an unusable state", () => {
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    try {
      workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 31 });
      applyAgentPrFetch(
        workerState,
        { repo: "acme/widgets", prNumber: 31 },
        { data: {}, etag: 'W/"1"', notModified: false },
      );
      applyAgentPrFetch(
        workerState,
        { repo: "acme/widgets", prNumber: 31 },
        { data: { state: "closed" }, etag: 'W/"2"', notModified: false },
      );
      workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 31 });
      applyAgentPrFetch(
        workerState,
        { repo: "acme/widgets", prNumber: 31 },
        { data: {}, etag: 'W/"3"', notModified: false },
      );
    } finally {
      warn.mockRestore();
    }

    expect(warnings.filter((message) => message.includes("unusable PR state"))).toHaveLength(2);
  });

  test("warnings for a PR closed outside the reconciler are forgotten", async () => {
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    try {
      workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 32 });
      applyAgentPrFetch(
        workerState,
        { repo: "acme/widgets", prNumber: 32 },
        { data: {}, etag: 'W/"1"', notModified: false },
      );
      // Simulate the CI watcher closing the row: it never calls applyAgentPrFetch.
      workerState.markAgentPrClosed("acme/widgets", 32);
      await reconcileOpenAgentPrs({
        workerState,
        github: {
          async fetchPr() {
            return open();
          },
        },
        watched: workerState.listOpenAgentPrs(),
      });
      workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 32 });
      applyAgentPrFetch(
        workerState,
        { repo: "acme/widgets", prNumber: 32 },
        { data: {}, etag: 'W/"2"', notModified: false },
      );
    } finally {
      warn.mockRestore();
    }

    expect(warnings.filter((message) => message.includes("unusable PR state"))).toHaveLength(2);
  });

  test("state open keeps the row watched without warning", () => {
    const warn = spyOn(console, "warn");
    try {
      workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 50 });
      const closure = applyAgentPrFetch(
        workerState,
        { repo: "acme/widgets", prNumber: 50 },
        { data: { state: "open" }, etag: 'W/"2"', notModified: false },
      );

      expect(closure).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      expect(workerState.listOpenAgentPrs()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("state closed and merged close the row with a terminal reason", () => {
    for (const [prNumber, state] of [
      [51, "closed"],
      [52, "merged"],
    ] as const) {
      workerState.recordAgentPr({ repo: "acme/widgets", prNumber });
      const closure = applyAgentPrFetch(
        workerState,
        { repo: "acme/widgets", prNumber },
        { data: { state }, etag: 'W/"3"', notModified: false },
      );

      expect(closure).toEqual({ repo: "acme/widgets", prNumber, reason: state });
      expect(workerState.listOpenAgentPrs()).toHaveLength(0);
    }
  });

  test("reconciliation leaves a row open when the payload omits state", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 40 });
    const fresh = new Map<string, ConditionalResult<PolledPr>>();
    const summary = await reconcileOpenAgentPrs({
      workerState,
      github: {
        async fetchPr() {
          return { data: {}, etag: 'W/"4"', notModified: false };
        },
      },
      watched: workerState.listOpenAgentPrs(),
      fresh,
    });

    expect(summary.checked).toBe(1);
    expect(summary.closed).toEqual([]);
    expect(workerState.listOpenAgentPrs().map((pr) => pr.prNumber)).toEqual([40]);
    // The unusable payload's ETag is not cached, so the next tick re-reads it
    // instead of trusting a 304 that carries no state.
    expect(workerState.getCursor(agentPrStateCursorSource("acme/widgets", 40))).toBeNull();
    // The fetch is still shared with the per-PR poll loop (no second request).
    expect(fresh.get(agentPrKey("acme/widgets", 40))?.data).toEqual({});
  });
});
