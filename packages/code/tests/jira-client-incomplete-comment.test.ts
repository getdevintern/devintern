import { describe, test, expect, beforeEach } from "bun:test";
import { JiraTaskTrackerClient as JiraClient } from "../src/lib/trackers/jira/jira-task-tracker-client";

describe("JiraClient.hasIncompleteImplementationMarker", () => {
  let client: JiraClient;
  const issueKey = "PROJ-123";

  beforeEach(() => {
    client = new JiraClient("https://example.atlassian.net", "user@example.com", "token");
  });

  test("returns true when an incomplete automation comment exists", async () => {
    client.jiraApiCall = async (method, url) => {
      if (method === "GET" && url.includes("/comment")) {
        return {
          comments: [
            {
              id: "1",
              author: { displayName: "DevIntern" },
              created: "2024-01-01T00:00:00.000Z",
              updated: "2024-01-01T00:00:00.000Z",
              renderedBody: "<h3>⚠️ Implementation Incomplete</h3>",
              body: {
                type: "doc",
                version: 1,
                content: [
                  {
                    type: "heading",
                    attrs: { level: 3 },
                    content: [{ type: "text", text: "⚠️ Implementation Incomplete" }],
                  },
                ],
              },
            },
          ],
        };
      }
      throw new Error(`Unexpected API call: ${method} ${url}`);
    };

    const result = await client.hasIncompleteImplementationMarker(issueKey);
    expect(result).toBe(true);
  });

  test("returns false when no incomplete automation comment exists on the issue", async () => {
    client.jiraApiCall = async () => ({
      comments: [{ id: "1", renderedBody: "Regular human comment", body: "Regular human comment" }],
    });

    const result = await client.hasIncompleteImplementationMarker(issueKey);
    expect(result).toBe(false);
  });

  test("fails open (returns false) when the comments API errors", async () => {
    client.jiraApiCall = async () => {
      throw new Error("boom");
    };

    const result = await client.hasIncompleteImplementationMarker(issueKey);
    expect(result).toBe(false);
  });

  test("detects incomplete comment via unfiltered fetch even though getComments would filter it", async () => {
    client.jiraApiCall = async (method, url) => {
      if (method === "GET" && url.includes("/comment")) {
        return {
          comments: [
            {
              id: "1",
              renderedBody: "<h3>⚠️ Implementation Incomplete</h3>",
              body: "⚠️ Implementation Incomplete",
              author: { displayName: "@devintern/code" },
              created: "2024-01-01T00:00:00.000Z",
              updated: "2024-01-01T00:00:00.000Z",
            },
          ],
        };
      }
      throw new Error(`Unexpected API call: ${method} ${url}`);
    };

    const filtered = await client.getComments(issueKey);
    expect(filtered).toHaveLength(0);

    const result = await client.hasIncompleteImplementationMarker(issueKey);
    expect(result).toBe(true);
  });
});
