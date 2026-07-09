import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import { JiraTaskTrackerClient as JiraClient } from "../src/lib/trackers/jira/jira-task-tracker-client";

describe("JiraClient.hasIncompleteImplementationComment", () => {
  let tempDir: string;
  let client: JiraClient;
  const issueKey = "PROJ-123";
  const description = "Task description for duplicate detection";

  beforeEach(() => {
    tempDir = path.join("/tmp", `devintern-incomplete-test-${Date.now()}-${Math.random()}`);
    process.env.DEVINTERN_OUTPUT_DIR = tempDir;

    const taskDir = path.join(tempDir, issueKey.toLowerCase());
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, "incomplete-task-description.txt"), description, "utf8");

    client = new JiraClient("https://example.atlassian.net", "user@example.com", "token");
  });

  afterEach(() => {
    delete process.env.DEVINTERN_OUTPUT_DIR;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns true when saved description matches and incomplete automation comment exists", async () => {
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

    const result = await client.hasIncompleteImplementationComment(issueKey, description);
    expect(result).toBe(true);
  });

  test("returns false when description file does not match current description", async () => {
    client.jiraApiCall = async () => ({
      comments: [{ id: "1", renderedBody: "⚠️ Implementation Incomplete", body: "" }],
    });

    const result = await client.hasIncompleteImplementationComment(
      issueKey,
      "Updated task description",
    );
    expect(result).toBe(false);
  });

  test("returns false when no incomplete automation comment exists on the issue", async () => {
    client.jiraApiCall = async () => ({
      comments: [{ id: "1", renderedBody: "Regular human comment", body: "Regular human comment" }],
    });

    const result = await client.hasIncompleteImplementationComment(issueKey, description);
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

    const result = await client.hasIncompleteImplementationComment(issueKey, description);
    expect(result).toBe(true);
  });
});
