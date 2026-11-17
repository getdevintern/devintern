import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { RowParseError } from "../src/lib/state/row-parse";
import { WorkerState, parseGitHubPrUrl, recordAgentPrFromUrl } from "../src/lib/state/worker-state";

/** Insert a row directly, bypassing the store, to simulate corrupted state. */
function insertRawRow(dbPath: string, sql: string): void {
  const { Database } = require("bun:sqlite");
  const raw = new Database(dbPath);
  try {
    raw.run(sql);
  } finally {
    raw.close();
  }
}

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

    test("startup sweep drops only closed PRs' per-PR cursors and is idempotent", () => {
      const kinds = ["pr", "reviews", "cipr", "ciactions", "cistatus"];
      const seed = (n: number) => {
        for (const kind of kinds) state.setCursor(`github:${kind}:acme/widgets#${n}`, "v", "e");
        state.setCursor(`github:prcomments:acme/widgets#${n}`, "2026-11-01T00:00:00Z");
      };
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 1 });
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 2 });
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 3 });
      // Close rows the pre-pruning way: state flip only, cursors left behind.
      for (const n of [1, 2, 3]) seed(n);
      const db = new Database(dbPath);
      db.run("UPDATE agent_prs SET state = 'closed' WHERE pr_number IN (1, 3)");
      db.close();
      seed(4); // no agent_prs row: another subsystem's, never touched
      for (const source of ["jira", "github:mention:prcomments:acme/widgets", "worker:relay"]) {
        state.setCursor(source, "v");
      }

      expect(state.pruneClosedChangeRequestCursors()).toBe(10);

      const sources = state.listCursors().map((cursor) => cursor.source);
      for (const n of [1, 3]) {
        expect(sources.filter((source) => source.endsWith(`#${n}`))).toEqual([
          `github:prcomments:acme/widgets#${n}`,
        ]);
      }
      for (const n of [2, 4]) {
        for (const kind of kinds) expect(sources).toContain(`github:${kind}:acme/widgets#${n}`);
      }
      expect(sources).toContain("jira");
      expect(sources).toContain("github:mention:prcomments:acme/widgets");
      expect(sources).toContain("worker:relay");

      expect(state.pruneClosedChangeRequestCursors()).toBe(0);
      expect(state.listCursors().map((cursor) => cursor.source)).toEqual(sources);
    });

    test("markAgentPrClosed leaves cursors of an unregistered PR alone", () => {
      state.setCursor("github:pr:acme/widgets#5", "state", "e");
      state.markAgentPrClosed("acme/widgets", 5);
      expect(state.getCursor("github:pr:acme/widgets#5")).not.toBeNull();
    });

    test("closing a GitLab MR drops its CI watcher cursors", () => {
      const mr = {
        provider: "gitlab" as const,
        instanceUrl: "https://gitlab.example",
        projectPath: "group/app",
        number: 9,
        webUrl: "https://gitlab.example/group/app/-/merge_requests/9",
      };
      state.recordAgentChangeRequest(mr);
      state.recordAgentChangeRequest({ ...mr, number: 10, webUrl: `${mr.webUrl}0` });
      for (const n of [9, 10]) {
        for (const kind of ["cipr", "ciactions", "cistatus"]) {
          state.setCursor(`gitlab:${kind}:https://gitlab.example:group/app#${n}`, "v");
        }
      }

      state.markAgentChangeRequestClosed(mr);

      const sources = state.listCursors().map((cursor) => cursor.source);
      expect(sources.some((source) => source.endsWith("#9"))).toBe(false);
      expect(sources.filter((source) => source.endsWith("#10"))).toHaveLength(3);
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
      expect(open[0]).toMatchObject({
        provider: "github",
        instanceUrl: "https://github.com",
        projectPath: "acme/widgets",
        changeNumber: 42,
        webUrl: "https://github.com/acme/widgets/pull/42",
      });
    });

    test("provider-aware identities do not collide and GitHub polling stays isolated", () => {
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
      state.recordAgentChangeRequest({
        provider: "gitlab",
        instanceUrl: "https://git.example.test",
        projectId: "17",
        projectPath: "acme/widgets",
        number: 42,
        webUrl: "https://git.example.test/acme/widgets/-/merge_requests/42",
      });

      expect(state.listOpenAgentChangeRequests()).toHaveLength(2);
      expect(state.listOpenAgentPrs()).toHaveLength(1);
      expect(state.listOpenAgentPrs()[0]?.provider).toBe("github");
      expect(
        state.listOpenAgentChangeRequests().find((change) => change.provider === "gitlab"),
      ).toMatchObject({
        projectId: "17",
        projectPath: "acme/widgets",
        changeNumber: 42,
      });
    });

    test("markAgentPrClosed removes the PR from the open list", () => {
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
      state.markAgentPrClosed("acme/widgets", 42);
      expect(state.listOpenAgentPrs()).toHaveLength(0);
    });

    test("markAgentChangeRequestClosed targets the full provider identity", () => {
      const identity = {
        provider: "gitlab" as const,
        instanceUrl: "https://git.example.test",
        projectId: "17",
        projectPath: "acme/widgets",
        number: 42,
        webUrl: "https://git.example.test/acme/widgets/-/merge_requests/42",
      };
      state.recordAgentChangeRequest(identity);
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
      state.markAgentChangeRequestClosed(identity);

      expect(state.listOpenAgentChangeRequests()).toHaveLength(1);
      expect(state.listOpenAgentChangeRequests()[0]?.provider).toBe("github");
    });

    test("merged PRs are listed most recently merged first; plain closes are not", () => {
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 1 });
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 2 });
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 3 });
      state.markAgentPrClosed("acme/widgets", 1, { merged: true });
      state.markAgentPrClosed("acme/widgets", 2);
      insertRawRow(dbPath, "UPDATE agent_prs SET merged_at = merged_at - 1000 WHERE pr_number = 1");
      state.markAgentPrClosed("acme/widgets", 3, { merged: true });

      const merged = state.listMergedAgentChangeRequests(10);
      expect(merged.map((pr) => pr.prNumber)).toEqual([3, 1]);
      expect(merged[0]?.mergedAt).toBeNumber();
      expect(state.listMergedAgentChangeRequests(1).map((pr) => pr.prNumber)).toEqual([3]);
    });

    test("a later plain close keeps a recorded merge; reopening clears it", () => {
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 4 });
      state.markAgentPrClosed("acme/widgets", 4, { merged: true });
      state.markAgentPrClosed("acme/widgets", 4);
      expect(state.listMergedAgentChangeRequests(10)).toHaveLength(1);

      state.recordAgentPr({ repo: "acme/widgets", prNumber: 4 });
      expect(state.listMergedAgentChangeRequests(10)).toHaveLength(0);
      expect(state.listOpenAgentPrs()[0]?.mergedAt).toBeUndefined();
    });

    test("markAgentChangeRequestClosed records GitLab merges", () => {
      const identity = {
        provider: "gitlab" as const,
        instanceUrl: "https://git.example.test",
        projectId: "17",
        projectPath: "acme/widgets",
        number: 42,
        webUrl: "https://git.example.test/acme/widgets/-/merge_requests/42",
      };
      state.recordAgentChangeRequest(identity);
      state.markAgentChangeRequestClosed(identity, { merged: true });
      expect(state.listMergedAgentChangeRequests(10)).toMatchObject([
        { provider: "gitlab", changeNumber: 42 },
      ]);
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
      expect(open[0]).toMatchObject({
        provider: "github",
        instanceUrl: "https://github.com",
        projectPath: "acme/old",
        changeNumber: 1,
        webUrl: "https://github.com/acme/old/pull/1",
      });
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

    test("opening a provider-aware registry without merged_at adds the column", () => {
      const legacyPath = join(
        tmpdir(),
        `ws-premerge-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
      );
      const { Database } = require("bun:sqlite");
      const legacy = new Database(legacyPath);
      legacy.run(`
        CREATE TABLE agent_prs (
          provider TEXT NOT NULL,
          instance_url TEXT NOT NULL,
          project_id TEXT,
          project_path TEXT NOT NULL,
          change_number INTEGER NOT NULL,
          web_url TEXT NOT NULL,
          repo TEXT NOT NULL,
          pr_number INTEGER NOT NULL,
          branch TEXT,
          task_key TEXT,
          ticket_url TEXT,
          state TEXT NOT NULL DEFAULT 'open',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (provider, instance_url, project_path, change_number)
        )
      `);
      legacy.run(
        `INSERT INTO agent_prs (provider, instance_url, project_path, change_number, web_url,
           repo, pr_number, state, created_at, updated_at)
         VALUES ('github', 'https://github.com', 'acme/old', 1,
           'https://github.com/acme/old/pull/1', 'acme/old', 1, 'closed', 1, 1)`,
      );
      legacy.close();

      // A readonly reader (the dashboard) sees no merges on the old schema.
      const readonly = new WorkerState(legacyPath, { readonly: true });
      expect(readonly.listMergedAgentChangeRequests(10)).toEqual([]);
      readonly.close();

      const migrated = new WorkerState(legacyPath);
      expect(migrated.listMergedAgentChangeRequests(10)).toEqual([]);
      migrated.recordAgentPr({ repo: "acme/old", prNumber: 2 });
      migrated.markAgentPrClosed("acme/old", 2, { merged: true });
      expect(migrated.listMergedAgentChangeRequests(10).map((pr) => pr.prNumber)).toEqual([2]);
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

  describe("addressed_comments", () => {
    test("unmarked comments are not addressed", () => {
      expect(state.isCommentAddressed("acme/widgets", "review", 101)).toBe(false);
      expect(state.isCommentAddressed("acme/widgets", "conversation", 202)).toBe(false);
    });

    test("markCommentAddressed records and dedupes per repo/type/id", () => {
      state.markCommentAddressed("acme/widgets", "review", 101);
      expect(state.isCommentAddressed("acme/widgets", "review", 101)).toBe(true);
      // Same id in another repo or type stays untouched.
      expect(state.isCommentAddressed("acme/other", "review", 101)).toBe(false);
      expect(state.isCommentAddressed("acme/widgets", "conversation", 101)).toBe(false);
      // Idempotent.
      state.markCommentAddressed("acme/widgets", "review", 101);
      expect(state.isCommentAddressed("acme/widgets", "review", 101)).toBe(true);
    });

    test("markCommentsAddressed records batches idempotently", () => {
      state.markCommentsAddressed("acme/widgets", "conversation", [1, 2, 3]);
      state.markCommentsAddressed("acme/widgets", "conversation", [2, 4]);
      for (const id of [1, 2, 3, 4]) {
        expect(state.isCommentAddressed("acme/widgets", "conversation", id)).toBe(true);
      }
      // Batch helpers accept an empty list.
      expect(() => state.markCommentsAddressed("acme/widgets", "review", [])).not.toThrow();
    });

    test("marked comments persist across connections", () => {
      state.markCommentAddressed("acme/widgets", "review", 77);
      const second = new WorkerState(dbPath);
      try {
        expect(second.isCommentAddressed("acme/widgets", "review", 77)).toBe(true);
      } finally {
        second.close();
      }
    });
  });

  describe("malformed rows", () => {
    test("getCursor tolerates a blob cursor_value and reads as no cursor", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO cursors (source, cursor_value, updated_at) VALUES ('bad', x'00', 1)`,
      );
      expect(state.getCursor("bad")).toBeNull();
    });

    test("listCursors rejects a non-numeric updated_at", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO cursors (source, cursor_value, updated_at) VALUES ('bad', 'ok', 'later')`,
      );
      expect(() => state.listCursors()).toThrow(RowParseError);
    });

    test("listOpenAgentPrs skips a row with a blob repo", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO agent_prs (
           provider, instance_url, project_path, change_number, web_url,
           repo, pr_number, state, created_at, updated_at
         ) VALUES (
           'github', 'https://github.com', 'acme/widgets', 1,
           'https://github.com/acme/widgets/pull/1', x'00', 1, 'open', 1, 1
         )`,
      );
      state.recordAgentPr({ repo: "acme/ok", prNumber: 2 });
      const open = state.listOpenAgentPrs();
      expect(open).toHaveLength(1);
      expect(open[0]?.repo).toBe("acme/ok");
    });

    test("countAgentPrs skips an unrecognized state group", () => {
      state.recordAgentPr({ repo: "acme/widgets", prNumber: 1 });
      insertRawRow(
        dbPath,
        `INSERT INTO agent_prs (
           provider, instance_url, project_path, change_number, web_url,
           repo, pr_number, state, created_at, updated_at
         ) VALUES (
           'github', 'https://github.com', 'acme/other', 2,
           'https://github.com/acme/other/pull/2', x'00', 2, 'corrupt', 1, 1
         )`,
      );
      expect(state.countAgentPrs()).toEqual({ open: 1, closed: 0 });
    });

    test("getCiFixState rejects a non-numeric failure count instead of resetting the budget", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO ci_fix_state (repo, pr_number, consecutive_failures, updated_at)
         VALUES ('acme/widgets', 1, 'many', 1)`,
      );
      expect(() => state.getCiFixState("acme/widgets", 1)).toThrow(RowParseError);
    });

    test("getCiFixState rejects a negative failure count", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO ci_fix_state (repo, pr_number, consecutive_failures, updated_at)
         VALUES ('acme/widgets', 1, -1, 1)`,
      );
      expect(() => state.getCiFixState("acme/widgets", 1)).toThrow(RowParseError);
    });

    test("getTaskActioned rejects a non-numeric actioned_at", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO actioned_tasks (source, task_key, signal, actioned_at)
         VALUES ('jira', 'PROJ-1', 'sig', 'yesterday')`,
      );
      expect(() => state.getTaskActioned("jira", "PROJ-1")).toThrow(RowParseError);
    });

    test("getMeta rejects a blob value", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO worker_meta (key, value, updated_at) VALUES ('k', x'00', 1)`,
      );
      expect(() => state.getMeta("k")).toThrow(RowParseError);
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
