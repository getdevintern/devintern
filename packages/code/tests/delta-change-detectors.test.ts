import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createAsanaChangeDetector,
  createChangeDetector,
  createTrelloChangeDetector,
} from "../src/lib/change-detector";

describe("createTrelloChangeDetector", () => {
  test("first run establishes the cursor at the newest action and drains", async () => {
    const detector = createTrelloChangeDetector(async () => [
      { id: "action-3" },
      { id: "action-2" },
    ]);

    const result = await detector.changesSince(null);
    expect(result.changed).toBe(true);
    expect(result.nextCursor).toBe("action-3");
  });

  test("first run on an empty board still drains with a null cursor", async () => {
    const detector = createTrelloChangeDetector(async () => []);
    const result = await detector.changesSince(null);
    expect(result.changed).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  test("passes the cursor as since and reports no change on empty feed", async () => {
    const seen: (string | undefined)[] = [];
    const detector = createTrelloChangeDetector(async (since) => {
      seen.push(since);
      return [];
    });

    const result = await detector.changesSince("action-3");
    expect(seen).toEqual(["action-3"]);
    expect(result.changed).toBe(false);
    expect(result.nextCursor).toBe("action-3"); // cursor kept when feed is empty
  });

  test("new actions report changed and advance to the newest id", async () => {
    const detector = createTrelloChangeDetector(async () => [
      { id: "action-5" },
      { id: "action-4" },
    ]);

    const result = await detector.changesSince("action-3");
    expect(result.changed).toBe(true);
    expect(result.nextCursor).toBe("action-5");
  });
});

describe("createAsanaChangeDetector", () => {
  test("first run treats everything as changed and stores the sync token", async () => {
    const detector = createAsanaChangeDetector(async () => ({
      events: [],
      sync: "token-1",
      fullSync: true,
    }));

    const result = await detector.changesSince(null);
    expect(result.changed).toBe(true);
    expect(result.nextCursor).toBe("token-1");
  });

  test("expired token (412 full sync) drains with the fresh token", async () => {
    const detector = createAsanaChangeDetector(async () => ({
      events: [],
      sync: "token-fresh",
      fullSync: true,
    }));

    const result = await detector.changesSince("token-stale");
    expect(result.changed).toBe(true);
    expect(result.nextCursor).toBe("token-fresh");
  });

  test("empty event page reports no change and advances the token", async () => {
    const seen: (string | undefined)[] = [];
    const detector = createAsanaChangeDetector(async (sync) => {
      seen.push(sync);
      return { events: [], sync: "token-2", fullSync: false };
    });

    const result = await detector.changesSince("token-1");
    expect(seen).toEqual(["token-1"]);
    expect(result.changed).toBe(false);
    expect(result.nextCursor).toBe("token-2");
  });

  test("events report changed", async () => {
    const detector = createAsanaChangeDetector(async () => ({
      events: [{ action: "changed" }],
      sync: "token-3",
      fullSync: false,
    }));

    const result = await detector.changesSince("token-2");
    expect(result.changed).toBe(true);
    expect(result.nextCursor).toBe("token-3");
  });

  test("keeps the old token when the API returns none", async () => {
    const detector = createAsanaChangeDetector(async () => ({
      events: [],
      sync: "",
      fullSync: false,
    }));

    const result = await detector.changesSince("token-2");
    expect(result.nextCursor).toBe("token-2");
  });
});

describe("createChangeDetector registry (trello/asana)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const keys = [
    "TRELLO_API_KEY",
    "TRELLO_API_TOKEN",
    "TRELLO_DEFAULT_BOARD_ID",
    "ASANA_API_TOKEN",
    "ASANA_DEFAULT_PROJECT_GID",
  ];

  beforeEach(() => {
    for (const key of keys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  test("trello requires key, token, and default board id", () => {
    expect(createChangeDetector("trello")).toBeNull();

    process.env.TRELLO_API_KEY = "k";
    process.env.TRELLO_API_TOKEN = "t";
    expect(createChangeDetector("trello")).toBeNull(); // board id still missing

    process.env.TRELLO_DEFAULT_BOARD_ID = "board-1";
    expect(createChangeDetector("trello")?.source).toBe("trello");
  });

  test("asana requires token and default project gid", () => {
    expect(createChangeDetector("asana")).toBeNull();

    process.env.ASANA_API_TOKEN = "t";
    expect(createChangeDetector("asana")).toBeNull(); // project gid still missing

    process.env.ASANA_DEFAULT_PROJECT_GID = "1200";
    expect(createChangeDetector("asana")?.source).toBe("asana");
  });
});
