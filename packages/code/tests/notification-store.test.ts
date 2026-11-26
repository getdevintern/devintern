import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { addNotificationListener, NotificationEmitter } from "../src/lib/notifications/emitter";
import type { NotificationEvent } from "../src/lib/notifications/emitter";
import { NotificationStore, pruneNotifications } from "../src/lib/notifications/store";
import type { NotificationInput } from "../src/lib/notifications/types";

let dir: string;
let db: Database;
let clock: number;
let store: NotificationStore;

function input(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    kind: "escalated",
    severity: "high",
    groupKey: "escalated:auto_merge:acme/web:matches deny pattern docs/**",
    title: "Auto-merge left a PR open",
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notification-store-"));
  db = new Database(join(dir, "queue.db"));
  clock = 1_000;
  store = new NotificationStore(db, () => clock);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("NotificationStore grouping", () => {
  test("a first emit creates an unread row with count 1", () => {
    const result = store.emit(input({ runId: 1, repo: "acme/web", body: "why" }));
    expect(result.action).toBe("created");
    expect(result.notification).toMatchObject({
      kind: "escalated",
      severity: "high",
      count: 1,
      runId: 1,
      repo: "acme/web",
      body: "why",
      createdAt: 1_000,
      updatedAt: 1_000,
      muted: false,
    });
    expect(result.notification?.readAt).toBeUndefined();
  });

  test("emitting into an open group increments count, bumps updated_at, resurfaces, and updates text", () => {
    const first = store.emit(input({ runId: 1 })).notification!;
    clock = 2_000;
    store.markRead(first.id);
    expect(store.getById(first.id)?.readAt).toBe(2_000);

    clock = 3_000;
    const second = store.emit(input({ runId: 2, title: "Second title", body: "new body" }));
    expect(second.action).toBe("grouped");
    expect(second.notification).toMatchObject({
      id: first.id,
      count: 2,
      runId: 2,
      title: "Second title",
      body: "new body",
      createdAt: 1_000,
      updatedAt: 3_000,
    });
    expect(second.notification?.readAt).toBeUndefined();
    expect(store.list().total).toBe(1);
  });

  test("groupTitle renders the title from the new count", () => {
    const grouped = { groupTitle: (count: number) => `${count} things` };
    store.emit(input({ runId: 1, ...grouped }));
    const second = store.emit(input({ runId: 2, ...grouped }));
    expect(second.notification?.title).toBe("2 things");
  });

  test("re-emitting the same run refreshes the row without counting or resurfacing", () => {
    const first = store.emit(input({ runId: 7 })).notification!;
    store.markRead(first.id);
    const again = store.emit(input({ runId: 7, title: "Refreshed" }));
    expect(again.action).toBe("refreshed");
    expect(again.notification).toMatchObject({ count: 1, title: "Refreshed" });
    expect(again.notification?.readAt).toBeDefined();
  });

  test("appendLinks accumulates deduplicated links; otherwise links are replaced", () => {
    store.emit(input({ runId: 1, links: [{ label: "PR 1", url: "https://x.test/1" }] }));
    const appended = store.emit(
      input({
        runId: 2,
        appendLinks: true,
        links: [
          { label: "PR 1", url: "https://x.test/1" },
          { label: "PR 2", url: "https://x.test/2" },
        ],
      }),
    );
    expect(appended.notification?.links.map((link) => link.label)).toEqual(["PR 1", "PR 2"]);
    const replaced = store.emit(input({ runId: 3, links: [{ label: "Only" }] }));
    expect(replaced.notification?.links).toEqual([{ label: "Only" }]);
  });

  test("links drop non-http URLs and unlabeled entries", () => {
    const created = store.emit(
      input({
        links: [
          { label: "evil", url: "javascript:alert(1)" },
          { label: "", url: "https://x.test" },
          { label: "run", runId: 4 },
        ],
      }),
    );
    expect(created.notification?.links).toEqual([{ label: "evil" }, { label: "run", runId: 4 }]);
  });

  test("different group keys stay separate rows", () => {
    store.emit(input({ groupKey: "a" }));
    store.emit(input({ groupKey: "b" }));
    expect(store.list().total).toBe(2);
  });
});

describe("NotificationStore resolve", () => {
  test("resolving closes the group; the next emit opens a fresh row", () => {
    const first = store.emit(input({ runId: 1 })).notification!;
    clock = 5_000;
    expect(store.resolve(first.id)).toBe(true);
    expect(store.getById(first.id)?.resolvedAt).toBe(5_000);
    expect(store.findOpenGroup(first.groupKey)).toBeNull();

    const next = store.emit(input({ runId: 2 }));
    expect(next.action).toBe("created");
    expect(next.notification?.id).not.toBe(first.id);
    expect(next.notification?.count).toBe(1);
  });

  test("resolve of an unknown id is false", () => {
    expect(store.resolve(999)).toBe(false);
    expect(store.markRead(999)).toBe(false);
  });

  test("resolveMatching filters by kind and subject or group key", () => {
    store.emit(input({ groupKey: "e1", subject: "task:A" }));
    store.emit(input({ groupKey: "r1", kind: "retries_exhausted", subject: "task:A" }));
    store.emit(
      input({ groupKey: "w1", kind: "work_spawned", severity: "normal", subject: "task:A" }),
    );
    store.emit(input({ groupKey: "e2", subject: "task:B" }));

    expect(
      store.resolveMatching({ kinds: ["escalated", "retries_exhausted"], subject: "task:A" }),
    ).toBe(2);
    expect(
      store
        .list({ unresolved: true })
        .notifications.map((n) => n.groupKey)
        .sort(),
    ).toEqual(["e2", "w1"]);
    expect(store.resolveMatching({ kinds: ["escalated"], groupKey: "e2" })).toBe(1);
    expect(store.resolveMatching({ kinds: [], subject: "task:A" })).toBe(0);
    expect(store.resolveMatching({ kinds: ["escalated"] })).toBe(0);
  });
});

describe("NotificationStore mute", () => {
  test("a muted group suppresses emits and hides its open row; unmute restores it", () => {
    const first = store.emit(input({ runId: 1 })).notification!;
    store.mute(first.groupKey);
    expect(store.isMuted(first.groupKey)).toBe(true);
    expect(store.getById(first.id)?.muted).toBe(true);

    const suppressed = store.emit(input({ runId: 2 }));
    expect(suppressed.action).toBe("muted");
    expect(store.getById(first.id)?.count).toBe(1);
    expect(store.list().total).toBe(0);
    expect(store.list({ includeMuted: true }).total).toBe(1);
    expect(store.unreadCount().unread).toBe(0);
    expect(store.listMutes()).toEqual([{ groupKey: first.groupKey, mutedAt: 1_000 }]);

    expect(store.unmute(first.groupKey)).toBe(true);
    expect(store.unmute(first.groupKey)).toBe(false);
    expect(store.emit(input({ runId: 3 })).notification?.count).toBe(2);
    expect(store.unreadCount().unread).toBe(1);
  });

  test("a mute persists across connections", () => {
    store.mute("persisted");
    const other = new Database(join(dir, "queue.db"));
    try {
      const otherStore = new NotificationStore(other);
      expect(otherStore.emit(input({ groupKey: "persisted" })).action).toBe("muted");
    } finally {
      other.close();
    }
  });
});

describe("NotificationStore reads", () => {
  test("list filters by unresolved, severity, and kind, newest first, with pagination", () => {
    for (let index = 0; index < 5; index += 1) {
      clock = 1_000 + index;
      store.emit(
        input({
          groupKey: `g${index}`,
          kind: index % 2 === 0 ? "escalated" : "pr_opened",
          severity: index % 2 === 0 ? "high" : "normal",
        }),
      );
    }
    store.resolve(store.findOpenGroup("g4")!.id);

    const all = store.list();
    expect(all.total).toBe(5);
    expect(all.notifications.map((n) => n.groupKey)).toEqual(["g4", "g3", "g2", "g1", "g0"]);
    expect(store.list({ unresolved: true }).total).toBe(4);
    expect(store.list({ severity: "high" }).total).toBe(3);
    expect(store.list({ kind: "pr_opened" }).total).toBe(2);
    const page = store.list({ limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.notifications.map((n) => n.groupKey)).toEqual(["g3", "g2"]);
  });

  test("unread count covers unread, unresolved, unmuted rows; markAllRead clears it", () => {
    store.emit(input({ groupKey: "h1" }));
    store.emit(input({ groupKey: "n1", severity: "normal", kind: "pr_opened" }));
    const resolved = store.emit(input({ groupKey: "h2" })).notification!;
    store.resolve(resolved.id);
    expect(store.unreadCount()).toEqual({ unread: 2, unreadHigh: 1 });
    expect(store.markAllRead()).toBe(3);
    expect(store.unreadCount()).toEqual({ unread: 0, unreadHigh: 0 });
  });

  test("a malformed persisted row fails at the read boundary", () => {
    store.emit(input());
    db.run("UPDATE notifications SET kind = 'bogus'");
    expect(() => store.list()).toThrow(/kind/);
  });

  test("pruning drops resolved rows past the retention window and keeps open ones", () => {
    clock = 1_000;
    const resolved = store.emit(input({ groupKey: "old" })).notification!;
    store.resolve(resolved.id);
    clock = 2_000;
    const openRow = store.emit(input({ groupKey: "open" })).notification!;

    // cutoff = 2_001 - 1_000 = 1_001: the row resolved at 1_000 is dropped.
    expect(pruneNotifications(db, 1_000, 2_001)).toBe(1);
    expect(store.getById(resolved.id)).toBeNull();
    expect(store.getById(openRow.id)).not.toBeNull();
    expect(store.unreadCount().unread).toBe(1);
  });

  test("pruning drops aged-out informational rows that no rule ever resolves", () => {
    clock = 1_000;
    const opened = store.emit(
      input({ kind: "pr_opened", severity: "normal", groupKey: "pr_opened:acme/web:day-1" }),
    ).notification!;
    const merged = store.emit(
      input({
        kind: "pr_auto_merged",
        severity: "normal",
        groupKey: "pr_auto_merged:acme/web:day-1",
      }),
    ).notification!;
    const spawned = store.emit(
      input({ kind: "work_spawned", severity: "normal", groupKey: "work_spawned:run:1" }),
    ).notification!;
    // A still-actionable open row is not on the never-resolved list.
    const escalation = store.emit(input({ groupKey: "escalated:task:DEV-1" })).notification!;

    clock = 50_000;
    // cutoff = 50_001 - 1_000 = 49_001: every row above is older than that.
    expect(pruneNotifications(db, 1_000, 50_001)).toBe(3);
    expect(store.getById(opened.id)).toBeNull();
    expect(store.getById(merged.id)).toBeNull();
    expect(store.getById(spawned.id)).toBeNull();
    expect(store.getById(escalation.id)).not.toBeNull();
  });

  test("the unread-count predicate has a partial index", () => {
    const index = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_notifications_unread");
    expect(index).not.toBeNull();
  });
});

describe("NotificationEmitter", () => {
  test("publishes created, grouped, updated, and resolved events to listeners", () => {
    const events: NotificationEvent["type"][] = [];
    const stop = addNotificationListener((event) => events.push(event.type));
    try {
      const emitter = new NotificationEmitter(db, () => clock);
      emitter.emit(input({ runId: 1 }));
      emitter.emit(input({ runId: 2 }));
      emitter.update(input().groupKey, { body: "progress" });
      emitter.resolve({ kinds: ["escalated"], groupKey: input().groupKey });
      emitter.resolve({ kinds: ["escalated"], groupKey: input().groupKey });
    } finally {
      stop();
    }
    expect(events).toEqual(["created", "grouped", "updated", "resolved"]);
  });

  test("a throwing listener does not break the emit", () => {
    const stop = addNotificationListener(() => {
      throw new Error("listener boom");
    });
    try {
      const result = new NotificationEmitter(db).emit(input());
      expect(result.action).toBe("created");
    } finally {
      stop();
    }
  });
});
