import { afterEach, describe, expect, test } from "bun:test";
import { TrelloClient } from "./src/clients/trello.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(json: unknown): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify(json), { status: 200 });
  }) as typeof fetch;
  return urls;
}

describe("TrelloClient endpoint override", () => {
  test("constructor baseUrl is used for REST requests", async () => {
    const urls = mockFetch([]);
    const client = new TrelloClient({
      apiKey: "k",
      apiToken: "t",
      baseUrl: "http://127.0.0.1:1/1",
    });
    await client.getBoardLabels("board-1");
    expect(new URL(urls[0]).origin).toBe("http://127.0.0.1:1");
    expect(new URL(urls[0]).pathname).toBe("/1/boards/board-1/labels");
  });

  test("TRELLO_API_BASE_URL overrides the default REST endpoint", async () => {
    const previous = process.env.TRELLO_API_BASE_URL;
    process.env.TRELLO_API_BASE_URL = "http://127.0.0.1:1/1";
    try {
      const urls = mockFetch([]);
      const client = new TrelloClient({ apiKey: "k", apiToken: "t" });
      await client.getBoardLabels("board-1");
      expect(new URL(urls[0]).origin).toBe("http://127.0.0.1:1");
    } finally {
      if (previous === undefined) {
        delete process.env.TRELLO_API_BASE_URL;
      } else {
        process.env.TRELLO_API_BASE_URL = previous;
      }
    }
  });
});

describe("TrelloClient labels", () => {
  test("getBoardLabels hits the board labels endpoint", async () => {
    const urls = mockFetch([
      { id: "lab-1", name: "bug", color: "red" },
      { id: "lab-2", name: "", color: "green" },
    ]);

    const client = new TrelloClient({ apiKey: "k", apiToken: "t" });
    const labels = await client.getBoardLabels("board-1");

    expect(new URL(urls[0]).pathname).toBe("/1/boards/board-1/labels");
    expect(labels).toEqual([
      { id: "lab-1", name: "bug", color: "red" },
      { id: "lab-2", name: "", color: "green" },
    ]);
  });

  test("setCardLabels puts idLabels on the card", async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    const client = new TrelloClient({ apiKey: "k", apiToken: "t" });
    await client.setCardLabels("ABC123", ["lab-1", "lab-2"]);

    expect(new URL(urls[0]).pathname).toBe("/1/cards/ABC123");
    expect(bodies[0]).toContain("idLabels=lab-1%2Clab-2");
  });
});

describe("TrelloClient.searchCards", () => {
  test("searches cards with the query and limits", async () => {
    const urls = mockFetch({
      cards: [{ id: "abc", shortLink: "sL1", url: "u", name: "Fix login" }],
    });

    const client = new TrelloClient({ apiKey: "k", apiToken: "t" });
    const result = await client.searchCards('list:"To Do" is:open');

    const url = new URL(urls[0]);
    expect(url.pathname).toBe("/1/search");
    expect(url.searchParams.get("query")).toBe('list:"To Do" is:open');
    expect(url.searchParams.get("modelTypes")).toBe("cards");
    expect(url.searchParams.get("cards_limit")).toBe("100");
    expect(url.searchParams.has("idBoards")).toBe(false);
    expect(result.total).toBe(1);
    expect(result.cards[0].shortLink).toBe("sL1");
  });

  test("scopes to a board when provided", async () => {
    const urls = mockFetch({ cards: [] });

    const client = new TrelloClient({ apiKey: "k", apiToken: "t" });
    await client.searchCards("is:open", "board123");

    const url = new URL(urls[0]);
    expect(url.searchParams.get("idBoards")).toBe("board123");
  });

  test("returns empty result when no cards field", async () => {
    mockFetch({});

    const client = new TrelloClient({ apiKey: "k", apiToken: "t" });
    const result = await client.searchCards("nothing");

    expect(result).toEqual({ cards: [], total: 0 });
  });
});
