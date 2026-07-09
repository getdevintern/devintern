import { describe, test, expect, beforeEach } from "bun:test";
import { TaskTrackerManager } from "../src/lib/task-tracker-manager";
import { JiraTaskTrackerClient } from "../src/lib/trackers/jira/jira-task-tracker-client";
import { AsanaTaskTrackerClient } from "../src/lib/trackers/asana/asana-task-tracker-client";
import { AzureDevOpsTaskTrackerClient } from "../src/lib/trackers/azure-devops/azure-devops-task-tracker-client";
import { GitHubTaskTrackerClient } from "../src/lib/trackers/github/github-task-tracker-client";
import { LinearTaskTrackerClient } from "../src/lib/trackers/linear/linear-task-tracker-client";
import { TrelloTaskTrackerClient } from "../src/lib/trackers/trello/trello-task-tracker-client";

describe("TaskTrackerManager", () => {
  let manager: TaskTrackerManager;

  beforeEach(() => {
    manager = new TaskTrackerManager();
    manager.reset();
    delete process.env.TASK_TRACKER;
    delete process.env.LINEAR_API_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_STATUS_LABELS;
    delete process.env.AZURE_DEVOPS_ORG;
    delete process.env.AZURE_DEVOPS_PAT;
    delete process.env.AZURE_DEVOPS_PROJECT;
    delete process.env.ASANA_API_TOKEN;
    delete process.env.ASANA_DEFAULT_PROJECT_GID;
    delete process.env.ASANA_STORY_POINTS_FIELD;
    delete process.env.TRELLO_API_KEY;
    delete process.env.TRELLO_API_TOKEN;
    delete process.env.TRELLO_DEFAULT_BOARD_ID;
    delete process.env.TRELLO_DEFAULT_LIST_NAME;
  });

  test("defaults to jira when TASK_TRACKER is not set", () => {
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "test-token";

    const client = manager.getClient();
    expect(client).toBeDefined();
    expect(client instanceof JiraTaskTrackerClient).toBe(true);
  });

  test("returns jira client when TASK_TRACKER=jira", () => {
    process.env.TASK_TRACKER = "jira";
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "test-token";

    const client = manager.getClient();
    expect(client).toBeDefined();
    expect(client instanceof JiraTaskTrackerClient).toBe(true);
  });

  test("returns trello client when TASK_TRACKER=trello", () => {
    process.env.TASK_TRACKER = "trello";
    process.env.TRELLO_API_KEY = "test-api-key";
    process.env.TRELLO_API_TOKEN = "test-api-token";

    const client = manager.getClient();
    expect(client).toBeDefined();
    expect(client instanceof TrelloTaskTrackerClient).toBe(true);
  });

  test("passes optional Trello env vars to client", () => {
    process.env.TASK_TRACKER = "trello";
    process.env.TRELLO_API_KEY = "test-api-key";
    process.env.TRELLO_API_TOKEN = "test-api-token";
    process.env.TRELLO_DEFAULT_BOARD_ID = "board123";
    process.env.TRELLO_DEFAULT_LIST_NAME = "In Progress";

    const client = manager.getClient() as TrelloTaskTrackerClient;
    expect(client.defaultBoardId).toBe("board123");
    expect(client.defaultListName).toBe("In Progress");
  });

  test("throws when Trello credentials are missing", () => {
    process.env.TASK_TRACKER = "trello";

    expect(() => manager.getClient()).toThrow("Missing required Trello credentials");
  });

  test("throws when TRELLO_API_KEY is missing", () => {
    process.env.TASK_TRACKER = "trello";
    process.env.TRELLO_API_TOKEN = "test-token";

    expect(() => manager.getClient()).toThrow("Missing required Trello credentials");
  });

  test("throws when TRELLO_API_TOKEN is missing", () => {
    process.env.TASK_TRACKER = "trello";
    process.env.TRELLO_API_KEY = "test-key";

    expect(() => manager.getClient()).toThrow("Missing required Trello credentials");
  });

  test("returns linear client when TASK_TRACKER=linear", () => {
    process.env.TASK_TRACKER = "linear";
    process.env.LINEAR_API_KEY = "lin_api_test";

    const client = manager.getClient();
    expect(client).toBeDefined();
    expect(client instanceof LinearTaskTrackerClient).toBe(true);
  });

  test("throws when Linear credentials are missing", () => {
    process.env.TASK_TRACKER = "linear";

    expect(() => manager.getClient()).toThrow("Missing required Linear credentials");
  });

  test("returns github client when TASK_TRACKER=github", () => {
    process.env.TASK_TRACKER = "github";
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.GITHUB_REPO = "acme/webapp";

    const client = manager.getClient();
    expect(client).toBeDefined();
    expect(client instanceof GitHubTaskTrackerClient).toBe(true);
  });

  test("throws when GitHub credentials are missing", () => {
    process.env.TASK_TRACKER = "github";
    delete process.env.GITHUB_TOKEN;

    expect(() => manager.getClient()).toThrow("Missing required GitHub credentials");
  });

  test("throws when GITHUB_REPO is not owner/repo", () => {
    process.env.TASK_TRACKER = "github";
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.GITHUB_REPO = "not-a-repo";

    expect(() => manager.getClient()).toThrow("Invalid GITHUB_REPO");
  });

  test("returns azure-devops client when TASK_TRACKER=azure-devops", () => {
    process.env.TASK_TRACKER = "azure-devops";
    process.env.AZURE_DEVOPS_ORG = "myorg";
    process.env.AZURE_DEVOPS_PAT = "pat";
    process.env.AZURE_DEVOPS_PROJECT = "MyProject";

    const client = manager.getClient();
    expect(client).toBeDefined();
    expect(client instanceof AzureDevOpsTaskTrackerClient).toBe(true);
  });

  test("throws when Azure DevOps credentials are missing", () => {
    process.env.TASK_TRACKER = "azure-devops";

    expect(() => manager.getClient()).toThrow("Missing required Azure DevOps credentials");
  });

  test("returns asana client when TASK_TRACKER=asana", () => {
    process.env.TASK_TRACKER = "asana";
    process.env.ASANA_API_TOKEN = "pat";

    const client = manager.getClient();
    expect(client).toBeDefined();
    expect(client instanceof AsanaTaskTrackerClient).toBe(true);
  });

  test("throws when Asana credentials are missing", () => {
    process.env.TASK_TRACKER = "asana";

    expect(() => manager.getClient()).toThrow("Missing required Asana credentials");
  });

  test("throws when TASK_TRACKER is unsupported", () => {
    process.env.TASK_TRACKER = "asana-not-yet";

    expect(() => manager.getClient()).toThrow("Unsupported task tracker");
  });

  test("throws when JIRA credentials are missing", () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;

    expect(() => manager.getClient()).toThrow("Missing required JIRA credentials");
  });

  test("caches the client instance", () => {
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "test-token";

    const client1 = manager.getClient();
    const client2 = manager.getClient();
    expect(client1).toBe(client2);
  });

  test("reset clears cached client", () => {
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "test-token";

    const client1 = manager.getClient();
    manager.reset();
    const client2 = manager.getClient();
    expect(client1).not.toBe(client2);
  });
});
