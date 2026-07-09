import { describe, expect, test } from "bun:test";
import { TrelloTaskTrackerClient } from "../src/lib/trackers/trello/trello-task-tracker-client";
import type { TrelloClient } from "@devintern/task-trackers";

describe("TrelloTaskTrackerClient.searchTasks", () => {
  test("searches cards scoped to the default board and normalizes results", async () => {
    let receivedQuery = "";
    let receivedBoard: string | undefined;
    const adapter = new TrelloTaskTrackerClient("k", "t", { defaultBoardId: "board123" });
    (adapter as unknown as { trelloClient: Partial<TrelloClient> }).trelloClient = {
      searchCards: async (query: string, boardId?: string) => {
        receivedQuery = query;
        receivedBoard = boardId;
        return {
          cards: [{ id: "abc", shortLink: "sL1", url: "u", name: "Fix login" }],
          total: 1,
        };
      },
      getCardWithDetails: async () => ({
        id: "abc",
        shortLink: "sL1",
        url: "u",
        shortUrl: "u",
        name: "Fix login",
        desc: "Details",
        idBoard: "board123",
        idList: "list1",
        idMembers: [],
        dateLastActivity: "2026-01-01",
        labels: [],
      }),
    } as Partial<TrelloClient>;

    const result = await adapter.searchTasks('list:"To Do" is:open');

    expect(receivedQuery).toBe('list:"To Do" is:open');
    expect(receivedBoard).toBe("board123");
    expect(result.total).toBe(1);
    expect(result.tasks[0].key).toBe("sL1");
    expect(result.tasks[0].summary).toBe("Fix login");
  });
});
