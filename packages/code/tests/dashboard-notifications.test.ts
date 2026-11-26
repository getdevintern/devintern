import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { startDashboardServer } from "../src/dashboard-server";
import { NotificationStore } from "../src/lib/notifications/store";
import {
  DashboardNotifications,
  parseMuteRequest,
  parseNotificationListQuery,
} from "../src/lib/observability/dashboard-notifications";
import type {
  NotificationListResponse,
  NotificationMutesResponse,
  NotificationReadAllResponse,
  NotificationUnreadResponse,
  NotificationWriteResponse,
} from "../src/lib/observability/dashboard-notifications";

let dir: string;
let dbPath: string;

function seed(): { high: number; normal: number } {
  const db = new Database(dbPath);
  try {
    const store = new NotificationStore(db);
    const high = store.emit({
      kind: "escalated",
      severity: "high",
      groupKey: "escalated:task:task:DEV-1",
      title: "Run #1 escalated",
      runId: 1,
    }).notification!.id;
    const normal = store.emit({
      kind: "pr_opened",
      severity: "normal",
      groupKey: "pr_opened:acme/web:2026-11-25",
      title: "Opened acme/web#1",
    }).notification!.id;
    return { high, normal };
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dashboard-notifications-"));
  dbPath = join(dir, "queue.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("request parsing", () => {
  test("list query parses filters and pagination", () => {
    const parsed = parseNotificationListQuery(
      new URLSearchParams("unresolved=1&severity=high&kind=escalated&limit=10&offset=20"),
    );
    expect(parsed).toEqual({
      ok: true,
      value: { unresolved: true, severity: "high", kind: "escalated", limit: 10, offset: 20 },
    });
    expect(parseNotificationListQuery(new URLSearchParams())).toEqual({
      ok: true,
      value: { limit: 50, offset: 0 },
    });
  });

  test("list query rejects bad values", () => {
    for (const query of [
      "severity=urgent",
      "kind=everything",
      "limit=0",
      "limit=1000",
      "offset=-1",
      "unresolved=maybe",
    ]) {
      expect(parseNotificationListQuery(new URLSearchParams(query)).ok).toBe(false);
    }
  });

  test("mute body requires a groupKey string", () => {
    expect(parseMuteRequest({ groupKey: "a" })).toEqual({ ok: true, value: { groupKey: "a" } });
    expect(parseMuteRequest(undefined).ok).toBe(false);
    expect(parseMuteRequest({ groupKey: "" }).ok).toBe(false);
    expect(parseMuteRequest({ groupKey: 3 }).ok).toBe(false);
    expect(parseMuteRequest({ groupKey: "x".repeat(501) }).ok).toBe(false);
  });
});

describe("DashboardNotifications handlers", () => {
  test("reads on a missing database are empty and create nothing", () => {
    const api = new DashboardNotifications(dbPath);
    expect(api.list(new URLSearchParams()).body).toEqual({
      notifications: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    expect(api.unreadCount().body).toEqual({ unread: 0, unreadHigh: 0 });
    expect(api.mutes().body).toEqual({ mutes: [] });
    expect(api.markRead("1").status).toBe(404);
    expect((api.markAllRead().body as NotificationReadAllResponse).updated).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  test("reads on a database without the notifications table are empty", () => {
    new Database(dbPath).close();
    const api = new DashboardNotifications(dbPath);
    expect((api.list(new URLSearchParams()).body as NotificationListResponse).total).toBe(0);
  });

  test("reads on an unreadable database degrade to empty instead of throwing", () => {
    writeFileSync(dbPath, "not a sqlite database");
    const api = new DashboardNotifications(dbPath);
    expect(api.list(new URLSearchParams()).status).toBe(200);
    expect((api.list(new URLSearchParams()).body as NotificationListResponse).total).toBe(0);
    expect(api.unreadCount().body as NotificationUnreadResponse).toEqual({
      unread: 0,
      unreadHigh: 0,
    });
    expect(api.mutes().body as NotificationMutesResponse).toEqual({ mutes: [] });
  });

  test("list, unread count, mark read, mark all read, resolve", () => {
    const { high, normal } = seed();
    const api = new DashboardNotifications(dbPath);

    const listed = api.list(new URLSearchParams("severity=high")).body as NotificationListResponse;
    expect(listed.total).toBe(1);
    expect(listed.notifications[0].id).toBe(high);
    expect(api.unreadCount().body as NotificationUnreadResponse).toEqual({
      unread: 2,
      unreadHigh: 1,
    });

    const read = api.markRead(String(high));
    expect(read.status).toBe(200);
    expect((read.body as NotificationWriteResponse).notification.readAt).toBeDefined();
    expect(api.unreadCount().body).toEqual({ unread: 1, unreadHigh: 0 });

    expect((api.markAllRead().body as NotificationReadAllResponse).updated).toBe(1);
    expect(api.unreadCount().body).toEqual({ unread: 0, unreadHigh: 0 });

    const resolved = api.resolve(String(normal));
    expect((resolved.body as NotificationWriteResponse).notification.resolvedAt).toBeDefined();
    expect(
      (api.list(new URLSearchParams("unresolved=true")).body as NotificationListResponse).total,
    ).toBe(1);

    expect(api.resolve("abc").status).toBe(400);
    expect(api.resolve("0").status).toBe(400);
    expect(api.resolve("999").status).toBe(404);
    expect(api.list(new URLSearchParams("kind=nope")).status).toBe(400);
  });

  test("mute hides a group and suppresses emits; unmute restores it", () => {
    seed();
    const api = new DashboardNotifications(dbPath);
    const groupKey = "escalated:task:task:DEV-1";
    expect(api.mute({ groupKey }).body).toEqual({ groupKey, muted: true });
    expect((api.list(new URLSearchParams()).body as NotificationListResponse).total).toBe(1);
    expect(
      (api.list(new URLSearchParams("includeMuted=1")).body as NotificationListResponse).total,
    ).toBe(2);
    expect((api.mutes().body as NotificationMutesResponse).mutes.map((m) => m.groupKey)).toEqual([
      groupKey,
    ]);
    expect(api.mute({}).status).toBe(400);

    expect(api.unmute({ groupKey }).body).toEqual({ groupKey, muted: false });
    expect((api.mutes().body as NotificationMutesResponse).mutes).toEqual([]);
    expect((api.list(new URLSearchParams()).body as NotificationListResponse).total).toBe(2);
  });
});

describe("dashboard server routes", () => {
  test("routes notification GETs and POSTs", async () => {
    const { high } = seed();
    const server = startDashboardServer({
      port: 0,
      dbPath,
      workingDir: dir,
      workspaceDir: dir,
      logDirs: [],
      tailscaleAutodetect: false,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { "Content-Type": "application/json", Origin: base };
      const post = (path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body ?? {}),
        });

      const list = await fetch(`${base}/api/notifications?unresolved=1`);
      expect(list.status).toBe(200);
      expect(((await list.json()) as NotificationListResponse).total).toBe(2);

      const count = await fetch(`${base}/api/notifications/unread-count`);
      expect(await count.json()).toEqual({ unread: 2, unreadHigh: 1 });

      expect((await post(`/api/notifications/${high}/read`)).status).toBe(200);
      expect((await post("/api/notifications/read-all")).status).toBe(200);
      expect((await post(`/api/notifications/${high}/resolve`)).status).toBe(200);
      expect((await post("/api/notifications/mute", { groupKey: "g" })).status).toBe(200);
      const mutes = await fetch(`${base}/api/notifications/mutes`);
      expect(((await mutes.json()) as NotificationMutesResponse).mutes[0].groupKey).toBe("g");
      expect((await post("/api/notifications/unmute", { groupKey: "g" })).status).toBe(200);
      expect((await post("/api/notifications/999/resolve")).status).toBe(404);
      expect((await fetch(`${base}/api/notifications?severity=bad`)).status).toBe(400);

      const after = await fetch(`${base}/api/notifications/unread-count`);
      expect(await after.json()).toEqual({ unread: 0, unreadHigh: 0 });

      // Writes stay behind the CSRF guard.
      const forged = await fetch(`${base}/api/notifications/read-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://evil.test" },
        body: "{}",
      });
      expect(forged.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });

  test("notification routes use the queue DB when it differs from run history", async () => {
    const historyDbPath = join(dir, "history.db");
    const workspaceDbPath = join(dir, "workspace.db");
    const writer = new Database(workspaceDbPath);
    let id: number;
    try {
      id = new NotificationStore(writer).emit({
        kind: "escalated",
        severity: "high",
        groupKey: "escalated:task:task:DEV-2",
        title: "Run #2 escalated",
        runId: 2,
      }).notification!.id;
    } finally {
      writer.close();
    }

    const server = startDashboardServer({
      port: 0,
      dbPath: historyDbPath,
      queueDbPath: workspaceDbPath,
      workingDir: dir,
      workspaceDir: dir,
      logDirs: [],
      tailscaleAutodetect: false,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { "Content-Type": "application/json", Origin: base };
      const listed = await fetch(`${base}/api/notifications`);
      expect(((await listed.json()) as NotificationListResponse).total).toBe(1);
      expect(await (await fetch(`${base}/api/notifications/unread-count`)).json()).toEqual({
        unread: 1,
        unreadHigh: 1,
      });

      const read = await fetch(`${base}/api/notifications/${id}/read`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(read.status).toBe(200);
      const verify = new Database(workspaceDbPath, { readonly: true });
      try {
        const row = verify.query("SELECT read_at FROM notifications WHERE id = ?").get(id) as {
          read_at: number | null;
        };
        expect(row.read_at).not.toBeNull();
      } finally {
        verify.close();
      }
      // Run history was never opened or created by the notification routes.
      expect(existsSync(historyDbPath)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
