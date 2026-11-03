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

  test("surfaces the Jira HTTP failure alongside the JQL", async () => {
    const client = new JiraTaskTrackerClient(
      "https://acme.atlassian.net",
      "user@example.com",
      "token",
    );

    const apiError = new Error(
      'JIRA API Error: 401 Unauthorized - {"errorMessages":["Unauthorized"]}',
    );
    client.jiraApiCall = async () => {
      throw apiError;
    };

    const jql = 'status = "To Do"';
    const error = await client.searchTasks(jql).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("401");
    expect(message).toContain("Unauthorized");
    expect(message).toContain(jql);
    expect(message.split(jql)).toHaveLength(2);
    expect((error as Error).cause).toBe(apiError);
  });

  test("surfaces a network failure message", async () => {
    const client = new JiraTaskTrackerClient(
      "https://acme.atlassian.net",
      "user@example.com",
      "token",
    );

    const networkError = new Error("getaddrinfo ENOTFOUND acme.atlassian.net");
    client.jiraApiCall = async () => {
      throw networkError;
    };

    const error = await client.searchTasks("key = DEV-87").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("getaddrinfo ENOTFOUND acme.atlassian.net");
    expect((error as Error).cause).toBe(networkError);
  });
});
