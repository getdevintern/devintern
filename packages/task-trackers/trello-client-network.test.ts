import { afterEach, describe, expect, test } from "bun:test";
import { TrelloClient } from "./src/clients/trello.ts";

const originalFetch = globalThis.fetch;
const originalMaxRetries = process.env.DEVINTERN_FETCH_MAX_RETRIES;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMaxRetries === undefined) {
    delete process.env.DEVINTERN_FETCH_MAX_RETRIES;
  } else {
    process.env.DEVINTERN_FETCH_MAX_RETRIES = originalMaxRetries;
  }
});

// Bun's fetch throws this exact TypeError when the host is unreachable
// (offline, DNS failure, connection refused) — Sentry DEVINTERN-8.
const UNABLE_TO_CONNECT = new TypeError(
  "Unable to connect. Is the computer able to access the url?",
);

function mockFlakyFetch(failures: number, result: unknown): { attempts: () => number } {
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    if (attempts <= failures) {
      throw UNABLE_TO_CONNECT;
    }
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  return { attempts: () => attempts };
}

describe("TrelloClient transient network failures (DEVINTERN-8)", () => {
  test("getBoards recovers when the connection error clears within the retry budget", async () => {
    process.env.DEVINTERN_FETCH_MAX_RETRIES = "2";
    const mock = mockFlakyFetch(1, [{ id: "board-1", name: "Board", shortUrl: "u" }]);

    const client = new TrelloClient({ apiKey: "k", apiToken: "t" });
    const boards = await client.getBoards();

    expect(boards).toHaveLength(1);
    expect(mock.attempts()).toBe(2);
  });

  test("searchCards recovers when the connection error clears within the retry budget", async () => {
    process.env.DEVINTERN_FETCH_MAX_RETRIES = "2";
    const mock = mockFlakyFetch(1, {
      cards: [{ id: "c1", shortLink: "sL1", url: "u", name: "n" }],
    });

    const client = new TrelloClient({ apiKey: "k", apiToken: "t" });
    const result = await client.searchCards("is:open");

    expect(result.total).toBe(1);
    expect(mock.attempts()).toBe(2);
  });

  test("surfaces the connection error when retries are disabled", async () => {
    process.env.DEVINTERN_FETCH_MAX_RETRIES = "0";
    const mock = mockFlakyFetch(Number.POSITIVE_INFINITY, []);

    const client = new TrelloClient({ apiKey: "k", apiToken: "t" });
    await expect(client.getBoards()).rejects.toThrow("Unable to connect");
    expect(mock.attempts()).toBe(1);
  });
});
