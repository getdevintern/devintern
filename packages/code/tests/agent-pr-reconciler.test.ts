import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  agentPrKey,
  agentPrStateCursorSource,
  applyAgentPrFetch,
  reconcileOpenAgentPrs,
} from "../src/lib/agent-pr-reconciler";
import type { ConditionalResult, PolledPr } from "../src/lib/agent-pr-reconciler";
import { WorkerState } from "../src/lib/worker-state";

describe("agent PR reconciler", () => {
  let dbPath: string;
  let workerState: WorkerState;

  beforeEach(() => {
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

  test("a gone PR (renamed, deleted, or inaccessible) is closed", async () => {
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

    expect(summary.closed).toEqual([
      { repo: "acme/widgets", prNumber: 8, reason: "gone from GitHub" },
    ]);
    expect(workerState.listOpenAgentPrs()).toHaveLength(0);
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
});
