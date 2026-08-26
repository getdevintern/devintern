import { describe, expect, test } from "bun:test";

import { JiraTaskTrackerClient } from "../src/lib/trackers/jira/jira-task-tracker-client";

describe("JiraTaskTrackerClient.searchTasks", () => {
  test("maps fields.updated so the worker can dedupe by stamp", async () => {
    const client = new JiraTaskTrackerClient(
      "https://acme.atlassian.net",
      "user@example.com",
      "token",
    );

    let capturedUrl = "";
    client.jiraApiCall = async (_method, url) => {
      capturedUrl = url;
      return {
        issues: [
          {
            key: "DEV-87",
            fields: {
              summary: "Remove requireTeamAutomation gate",
              updated: "2026-08-25T18:14:06.827+0700",
              status: { name: "To Do" },
              labels: ["intern"],
              components: [{ name: "code" }],
            },
          },
        ],
        total: 1,
      };
    };

    const result = await client.searchTasks('status = "To Do" AND labels = "Intern"');

    expect(decodeURIComponent(capturedUrl)).toContain("fields=");
    expect(decodeURIComponent(capturedUrl)).toContain("updated");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.key).toBe("DEV-87");
    expect(result.tasks[0]?.updated).toBe("2026-08-25T18:14:06.827+0700");
    expect(result.tasks[0]?.labels).toEqual(["intern"]);
    expect(result.tasks[0]?.components).toEqual(["code"]);
  });

  test("search results without fields.updated produce an empty stamp", async () => {
    const client = new JiraTaskTrackerClient(
      "https://acme.atlassian.net",
      "user@example.com",
      "token",
    );

    client.jiraApiCall = async () => ({
      issues: [{ key: "DEV-87", id: "10182", self: "https://example/DEV-87" }],
      total: 1,
    });

    const result = await client.searchTasks("key = DEV-87");
    expect(result.tasks[0]?.key).toBe("DEV-87");
    expect(result.tasks[0]?.updated).toBe("");
  });
});
