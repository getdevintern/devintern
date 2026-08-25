import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { WebhookQueue } from "../src/lib/webhook-queue";
import { WorkerState, parseGitHubPrUrl } from "../src/lib/worker-state";

describe("WorkerState", () => {
  let dbPath: string;
  let state: WorkerState;

  beforeEach(() => {
    dbPath = join(tmpdir(), `ws-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    state = new WorkerState(dbPath);
  });

  afterEach(() => {
    state.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  describe("cursors", () => {
    test("getCursor returns null for an unknown source", () => {
      expect(state.getCursor("jira")).toBeNull();
    });

    test("setCursor round-trips value and etag", () => {
      state.setCursor("github:reviews:acme/widgets#42", "2026-07-03T10:00:00Z", 'W/"abc"');
      const cursor = state.getCursor("github:reviews:acme/widgets#42");
      expect(cursor?.cursorValue).toBe("2026-07-03T10:00:00Z");
      expect(cursor?.etag).toBe('W/"abc"');
    });

    test("setCursor upserts and can drop the etag", () => {
      state.setCursor("jira", "2026-07-01T00:00:00Z", 'W/"old"');
      state.setCursor("jira", "2026-07-02T00:00:00Z");
      const cursor = state.getCursor("jira");
      expect(cursor?.cursorValue).toBe("2026-07-02T00:00:00Z");
      expect(cursor?.etag).toBeUndefined();
    });

    test("clearCursor removes the source", () => {
      state.setCursor("asana", "sync-token-1");
      state.clearCursor("asana");
      expect(state.getCursor("asana")).toBeNull();
    });

    test("cursors survive a restart", () => {
      state.setCursor("linear", "2026-07-03T09:00:00Z");
      const reopened = new WorkerState(dbPath);
      expect(reopened.getCursor("linear")?.cursorValue).toBe("2026-07-03T09:00:00Z");
      reopened.close();
    });
  });

  describe("agent_prs", () => {
    test("recordAgentPr + listOpenAgentPrs round-trips", () => {
      state.recordAgentPr({
        repo: "acme/widgets",
        prNumber: 42,
        branch: "feature/proj-1",
        taskKey: "PROJ-1",
      });

      const open = state.listOpenAgentPrs();
      expect(open).toHaveLength(1);
      expect(open[0]?.repo).toBe("acme/widgets");
      expect(open[0]?.prNumber).toBe(42);
      expect(open[0]?.branch).toBe("feature/proj-1");
      expect(open[0]?.taskKey).toBe("PROJ-1");
      expect(open[0]?.state).toBe("open");
    });

    test("markAgentPrClosed removes the PR from the open list", () => {
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
      state.markAgentPrClosed("acme/widgets", 42);
      expect(state.listOpenAgentPrs()).toHaveLength(0);
    });

    test("re-recording a closed PR reopens it", () => {
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
      state.markAgentPrClosed("acme/widgets", 42);
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 42, taskKey: "PROJ-9" });

      const open = state.listOpenAgentPrs();
      expect(open).toHaveLength(1);
      expect(open[0]?.taskKey).toBe("PROJ-9");
    });

    test("listOpenAgentPrs filters by repo", () => {
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 1 });
      state.recordAgentPr({ repo: "acme/gadgets", prNumber: 2 });

      expect(state.listOpenAgentPrs("acme/widgets")).toHaveLength(1);
      expect(state.listOpenAgentPrs("acme/gadgets")).toHaveLength(1);
      expect(state.listOpenAgentPrs()).toHaveLength(2);
    });

    test("registry survives a restart", () => {
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 7 });
      const reopened = new WorkerState(dbPath);
      expect(reopened.listOpenAgentPrs()).toHaveLength(1);
      reopened.close();
    });

    test("closeForeignAgentPrs closes only rows outside the allowlist", () => {
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 1 });
      state.recordAgentPr({ repo: "danii1/devintern", prNumber: 199 });
      state.recordAgentPr({ repo: "danii1/devintern", prNumber: 200 });
      state.markAgentPrClosed("danii1/devintern", 200);

      const closed = state.closeForeignAgentPrs(["acme/widgets"]);
      expect(closed).toEqual([{ repo: "danii1/devintern", prNumber: 199 }]);
      expect(state.listOpenAgentPrs().map((pr) => `${pr.repo}#${pr.prNumber}`)).toEqual([
        "acme/widgets#1",
      ]);
    });

    test("closeForeignAgentPrs is a no-op with an empty allowlist", () => {
      state.recordAgentPr({ repo: "danii1/devintern", prNumber: 199 });
      expect(state.closeForeignAgentPrs([])).toEqual([]);
      expect(state.listOpenAgentPrs()).toHaveLength(1);
    });
  });

  test("shares a database file with the webhook queue", () => {
    const queue = new WebhookQueue({ dbPath });
    queue.markProcessed("github", "delivery-1");
    state.setCursor("jira", "2026-07-03T00:00:00Z");

    expect(queue.hasProcessed("github", "delivery-1")).toBe(true);
    expect(state.getCursor("jira")?.cursorValue).toBe("2026-07-03T00:00:00Z");
    queue.close();
  });
});

describe("parseGitHubPrUrl", () => {
  test("parses a standard GitHub PR URL", () => {
    expect(parseGitHubPrUrl("https://github.com/acme/widgets/pull/142")).toEqual({
      repo: "acme/widgets",
      prNumber: 142,
    });
  });

  test("returns null for non-GitHub hosts", () => {
    expect(parseGitHubPrUrl("https://bitbucket.org/acme/widgets/pull-requests/3")).toBeNull();
  });

  test("returns null for non-PR GitHub URLs", () => {
    expect(parseGitHubPrUrl("https://github.com/acme/widgets/issues/5")).toBeNull();
  });
});
