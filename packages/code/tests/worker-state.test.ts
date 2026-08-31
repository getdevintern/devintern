import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { WebhookQueue } from "../src/lib/webhook-queue";
import { WorkerState, parseGitHubPrUrl, recordAgentPrFromUrl } from "../src/lib/worker-state";

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
        ticketUrl: "https://acme.atlassian.net/browse/PROJ-1",
      });

      const open = state.listOpenAgentPrs();
      expect(open).toHaveLength(1);
      expect(open[0]?.repo).toBe("acme/widgets");
      expect(open[0]?.prNumber).toBe(42);
      expect(open[0]?.branch).toBe("feature/proj-1");
      expect(open[0]?.taskKey).toBe("PROJ-1");
      expect(open[0]?.ticketUrl).toBe("https://acme.atlassian.net/browse/PROJ-1");
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

    test("opening a pre-ticket-url database adds the column and keeps rows readable", () => {
      const legacyPath = join(
        tmpdir(),
        `ws-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
      );
      const { Database } = require("bun:sqlite");
      const legacy = new Database(legacyPath);
      legacy.run(`
        CREATE TABLE agent_prs (
          repo TEXT NOT NULL,
          pr_number INTEGER NOT NULL,
          branch TEXT,
          task_key TEXT,
          state TEXT NOT NULL DEFAULT 'open',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (repo, pr_number)
        )
      `);
      legacy.run(
        `INSERT INTO agent_prs (repo, pr_number, task_key, created_at, updated_at)
         VALUES ('acme/old', 1, 'OLD-1', 1, 1)`,
      );
      legacy.close();

      const migrated = new WorkerState(legacyPath);
      const open = migrated.listOpenAgentPrs();
      expect(open).toHaveLength(1);
      expect(open[0]?.taskKey).toBe("OLD-1");
      expect(open[0]?.ticketUrl).toBeUndefined();
      migrated.recordAgentPr({
        repo: "acme/old",
        prNumber: 2,
        taskKey: "OLD-2",
        ticketUrl: "https://acme.atlassian.net/browse/OLD-2",
      });
      expect(migrated.listOpenAgentPrs().find((pr) => pr.prNumber === 2)?.ticketUrl).toBe(
        "https://acme.atlassian.net/browse/OLD-2",
      );
      migrated.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${legacyPath}${suffix}`, { force: true });
      }
    });

    test("recordAgentPrFromUrl freezes the ticket URL from the tracker active at record time", () => {
      const prevTracker = process.env.TASK_TRACKER;
      const prevJira = process.env.JIRA_BASE_URL;
      process.env.TASK_TRACKER = "jira";
      process.env.JIRA_BASE_URL = "https://acme.atlassian.net";
      try {
        recordAgentPrFromUrl("https://github.com/acme/widgets/pull/9", "feature/proj-3", "PROJ-3");
      } finally {
        // Simulate a later tracker switch: the stored link must not change.
        if (prevTracker === undefined) delete process.env.TASK_TRACKER;
        else process.env.TASK_TRACKER = prevTracker;
        if (prevJira === undefined) delete process.env.JIRA_BASE_URL;
        else process.env.JIRA_BASE_URL = prevJira;
      }
      // recordAgentPrFromUrl resolves the shared queue db; the isolation
      // preload pins it to a unique temp path for this test process.
      const shared = new WorkerState();
      try {
        const recorded = shared.listOpenAgentPrs("acme/widgets").find((pr) => pr.prNumber === 9);
        expect(recorded?.taskKey).toBe("PROJ-3");
        expect(recorded?.ticketUrl).toBe("https://acme.atlassian.net/browse/PROJ-3");
      } finally {
        shared.close();
      }
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
