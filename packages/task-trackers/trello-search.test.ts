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
