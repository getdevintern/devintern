import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  NOTIFICATION_SWEEP_INTERVAL_MS,
  notificationRetentionMs,
  pruneResolvedNotifications,
  startNotificationSweeper,
} from "../src/lib/notifications/maintenance";
import { NotificationStore } from "../src/lib/notifications/store";
import type { NotificationInput } from "../src/lib/notifications/types";

const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;
let dbPath: string;
const savedEnv = { ...process.env };

function input(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    kind: "escalated",
    severity: "high",
    groupKey: "escalated:task:DEV-1",
    title: "Needs a human",
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notification-maintenance-"));
  dbPath = join(dir, "queue.db");
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(dir, { recursive: true, force: true });
});

describe("notificationRetentionMs", () => {
  test("defaults to 30 days when the variable is unset", () => {
    delete process.env.WORKER_NOTIFICATION_RETENTION_DAYS;
    expect(notificationRetentionMs()).toBe(30 * DAY_MS);
  });

  test("accepts 0, which expires rows at the next sweep", () => {
    process.env.WORKER_NOTIFICATION_RETENTION_DAYS = "0";
    expect(notificationRetentionMs()).toBe(0);
  });

  test("reads a day count", () => {
    process.env.WORKER_NOTIFICATION_RETENTION_DAYS = "7";
    expect(notificationRetentionMs()).toBe(7 * DAY_MS);
  });

  test("falls back to the default for malformed or out-of-range values", () => {
    for (const value of ["abc", "-1", "1.5", ""]) {
      process.env.WORKER_NOTIFICATION_RETENTION_DAYS = value;
      expect(notificationRetentionMs()).toBe(30 * DAY_MS);
    }
  });

  test("the hourly sweep interval is one hour", () => {
    expect(NOTIFICATION_SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});

describe("pruneResolvedNotifications", () => {
  test("deletes aged-out rows and keeps open actionable ones", () => {
    const writer = new Database(dbPath);
    const store = new NotificationStore(writer, () => 1_000);
    const resolved = store.emit(input({ groupKey: "old-escalation" })).notification!;
    store.resolve(resolved.id);
    const open = store.emit(input({ groupKey: "open-escalation" })).notification!;
    writer.close();

    // Real clock: the rows were written at epoch 1_000, far past a 1-day window.
    pruneResolvedNotifications(dbPath, DAY_MS);

    const reader = new Database(dbPath);
    try {
      const remaining = new NotificationStore(reader).list({ includeMuted: true }).notifications;
      expect(remaining.map((notification) => notification.id)).toEqual([open.id]);
    } finally {
      reader.close();
    }
  });

  test("is a no-op when the database cannot be opened", () => {
    const missing = join(dir, "missing-dir", "queue.db");
    expect(() => pruneResolvedNotifications(missing, DAY_MS)).not.toThrow();
  });

  test("the periodic sweeper prunes on its interval", async () => {
    const writer = new Database(dbPath);
    const store = new NotificationStore(writer, () => 1_000);
    const resolved = store.emit(input()).notification!;
    store.resolve(resolved.id);
    writer.close();

    const timer = startNotificationSweeper(dbPath, () => 0, 10);
    try {
      let remaining = 1;
      for (let attempt = 0; attempt < 100 && remaining > 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const reader = new Database(dbPath);
        try {
          remaining = new NotificationStore(reader).list({ includeMuted: true }).total;
        } finally {
          reader.close();
        }
      }
      expect(remaining).toBe(0);
    } finally {
      clearInterval(timer);
    }
  });
});
