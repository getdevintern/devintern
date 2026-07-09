import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { MarkdownBackend } from "./lib/backends/markdown";
import { LinearBackend } from "./lib/backends/linear";
import { TrelloBackend } from "./lib/backends/trello";
import { AzureDevOpsBackend } from "./lib/backends/azure-devops";
import { AsanaBackend } from "./lib/backends/asana";
import { GitHubBackend } from "./lib/backends/github";

const TEST_DIR = join(import.meta.dir, "tmp-test-tasks");

describe("MarkdownBackend", () => {
  let backend: MarkdownBackend;

  beforeEach(async () => {
    backend = new MarkdownBackend({ directory: TEST_DIR });
    // Clean up test directory before each test
    try {
      await Bun.$`rm -rf ${TEST_DIR}`;
    } catch {
      // Directory might not exist
    }
  });

  afterEach(async () => {
    // Clean up test directory after each test
    try {
      await Bun.$`rm -rf ${TEST_DIR}`;
    } catch {
      // Directory might not exist
    }
  });

  test("should have correct name", () => {
    expect(backend.name).toBe("Markdown");
  });

  test("should support issue types", () => {
    expect(backend.supportsIssueTypes).toBe(true);
  });

  test("should not support epic linking", () => {
    expect(backend.supportsEpicLinking).toBe(false);
  });

  describe("createTask", () => {
    test("should create a markdown file with frontmatter", async () => {
      const result = await backend.createTask(
        "Add user authentication",
        "Implement OAuth 2.0 login with Google and GitHub providers.",
        "Story",
      );

      expect(result.key).toBeTruthy();
      expect(result.url).toBeTruthy();
      expect(result.url.startsWith(TEST_DIR)).toBe(true);

      const file = Bun.file(result.url);
      expect(await file.exists()).toBe(true);

      const content = await file.text();
      expect(content).toContain("# Add user authentication");
      expect(content).toContain("Implement OAuth 2.0 login with Google and GitHub providers.");
      expect(content).toContain("type: Story");
      expect(content).toContain("created_at:");
    });

    test("should create files in the specified directory", async () => {
      const result = await backend.createTask(
        "Fix navigation bug",
        "Mobile menu doesn't close on outside click.",
        "Bug",
      );

      expect(result.url.startsWith(TEST_DIR)).toBe(true);
      const file = Bun.file(result.url);
      expect(await file.exists()).toBe(true);
    });

    test("should sanitize filename from summary", async () => {
      const result = await backend.createTask(
        "This is a very long title with special chars: @#$%",
        "Description here.",
        "Task",
      );

      const file = Bun.file(result.url);
      expect(await file.exists()).toBe(true);

      // Filename should be sanitized (lowercase, no special chars, truncated)
      const basename = result.url.split("/").pop() || "";
      expect(basename.endsWith(".md")).toBe(true);
    });

    test("should generate unique keys for each task", async () => {
      const task1 = await backend.createTask("Task 1", "Desc 1", "Story");
      const task2 = await backend.createTask("Task 2", "Desc 2", "Story");

      expect(task1.key).not.toBe(task2.key);
    });
  });

  describe("createSubtask", () => {
    test("should append subtask to parent markdown file", async () => {
      const parent = await backend.createTask("Build API", "Create REST endpoints.", "Story");

      const subtask = await backend.createSubtask(
        parent.key,
        "Setup database schema",
        "Design tables for users and sessions.",
      );

      expect(subtask.url).toBe(parent.url);

      const file = Bun.file(parent.url);
      const content = await file.text();

      expect(content).toContain("## Subtasks");
      expect(content).toContain("- [ ] **Setup database schema**");
      expect(content).toContain("Design tables for users and sessions.");
    });

    test("should append multiple subtasks to same parent", async () => {
      const parent = await backend.createTask("Epic", "Description", "Epic");

      await backend.createSubtask(parent.key, "Subtask 1", "Details 1");
      await backend.createSubtask(parent.key, "Subtask 2", "Details 2");

      const file = Bun.file(parent.url);
      const content = await file.text();

      expect(content).toContain("- [ ] **Subtask 1**");
      expect(content).toContain("- [ ] **Subtask 2**");
    });

    test("should create subtask without description", async () => {
      const parent = await backend.createTask("Parent", "Desc", "Story");

      await backend.createSubtask(parent.key, "Simple subtask");

      const file = Bun.file(parent.url);
      const content = await file.text();

      expect(content).toContain("- [ ] **Simple subtask**");
    });

    test("should throw when parent task not found", async () => {
      expect(backend.createSubtask("non-existent-task", "Subtask", "Desc")).rejects.toThrow(
        "Parent task not found",
      );
    });
  });

  describe("linkToEpic", () => {
    test("should add epic to frontmatter", async () => {
      const task = await backend.createTask("Feature", "Desc", "Story");

      await backend.linkToEpic(task.key, "EPIC-123");

      const file = Bun.file(task.url);
      const content = await file.text();

      expect(content).toContain("epic: EPIC-123");
    });

    test("should update existing epic in frontmatter", async () => {
      const task = await backend.createTask("Feature", "Desc", "Story");

      await backend.linkToEpic(task.key, "EPIC-123");
      await backend.linkToEpic(task.key, "EPIC-456");

      const file = Bun.file(task.url);
      const content = await file.text();

      expect(content).toContain("epic: EPIC-456");
      expect(content).not.toContain("epic: EPIC-123");
    });

    test("should throw when task not found", async () => {
      expect(backend.linkToEpic("non-existent", "EPIC-123")).rejects.toThrow("Task not found");
    });
  });

  describe("getProjects", () => {
    test("should return empty array", async () => {
      const projects = await backend.getProjects();
      expect(projects).toEqual([]);
    });
  });

  describe("getIssueTypes", () => {
    test("should return default issue types", async () => {
      const types = await backend.getIssueTypes();
      expect(types).toEqual(["Task", "Story", "Bug", "Epic"]);
    });
  });
});

describe("LinearBackend", () => {
  let backend: LinearBackend;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    backend = new LinearBackend({ apiKey: "test-api-key" });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: unknown) {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  }

  test("should have correct name", () => {
    expect(backend.name).toBe("Linear");
  });

  test("should not support issue types", () => {
    expect(backend.supportsIssueTypes).toBe(false);
  });

  test("should support epic linking", () => {
    expect(backend.supportsEpicLinking).toBe(true);
  });

  describe("createTask", () => {
    test("should create an issue via Linear API", async () => {
      mockFetch({
        data: {
          teams: {
            nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }],
          },
          issueCreate: {
            success: true,
            issue: {
              id: "issue-1",
              identifier: "ENG-42",
              url: "https://linear.app/issue/ENG-42",
            },
          },
        },
      });

      const result = await backend.createTask("Add auth", "Implement OAuth login", "Story");

      expect(result.key).toBe("ENG-42");
      expect(result.url).toBe("https://linear.app/issue/ENG-42");
    });

    test("should use specified team key", async () => {
      mockFetch({
        data: {
          teams: {
            nodes: [
              { id: "team-1", key: "ENG", name: "Engineering" },
              { id: "team-2", key: "DES", name: "Design" },
            ],
          },
          issueCreate: {
            success: true,
            issue: {
              id: "issue-1",
              identifier: "DES-1",
              url: "https://linear.app/issue/DES-1",
            },
          },
        },
      });

      const result = await backend.createTask("Design system", "Create tokens", "Task", "DES");

      expect(result.key).toBe("DES-1");
    });
  });

  describe("createSubtask", () => {
    test("should create a sub-issue linked to parent", async () => {
      let callCount = 0;
      (globalThis as any).fetch = async () => {
        callCount++;
        if (callCount === 1) {
          // issues query for parent (getIssueIdByIdentifier)
          return new Response(
            JSON.stringify({
              data: {
                issues: {
                  nodes: [{ id: "parent-id", identifier: "ENG-1" }],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (callCount === 2) {
          // teams query (resolveTeamId -> getTeams)
          return new Response(
            JSON.stringify({
              data: {
                teams: {
                  nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // issueCreate for subtask
        return new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: {
                  id: "sub-id",
                  identifier: "ENG-2",
                  url: "https://linear.app/issue/ENG-2",
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await backend.createSubtask("ENG-1", "Subtask", "Details");

      expect(result.key).toBe("ENG-2");
    });

    test("should throw when parent issue not found", async () => {
      mockFetch({
        data: {
          teams: {
            nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }],
          },
          issues: {
            nodes: [],
          },
        },
      });

      expect(backend.createSubtask("ENG-999", "Subtask", "Details")).rejects.toThrow(
        "Parent issue not found: ENG-999",
      );
    });
  });

  describe("linkToEpic", () => {
    test("should link story to epic via parent relationship", async () => {
      let callCount = 0;
      (globalThis as any).fetch = async () => {
        callCount++;
        if (callCount === 1) {
          // issues query for story
          return new Response(
            JSON.stringify({
              data: {
                issues: {
                  nodes: [{ id: "story-id", identifier: "ENG-1" }],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (callCount === 2) {
          // issues query for epic
          return new Response(
            JSON.stringify({
              data: {
                issues: {
                  nodes: [{ id: "epic-id", identifier: "ENG-0" }],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // issueUpdate
        return new Response(
          JSON.stringify({
            data: {
              issueUpdate: { success: true },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      await expect(backend.linkToEpic("ENG-1", "ENG-0")).resolves.toBeUndefined();
    });
  });

  describe("getProjects", () => {
    test("should return teams as projects", async () => {
      mockFetch({
        data: {
          teams: {
            nodes: [
              { id: "team-1", key: "ENG", name: "Engineering" },
              { id: "team-2", key: "DES", name: "Design" },
            ],
          },
        },
      });

      const projects = await backend.getProjects();
      expect(projects).toEqual([
        { key: "ENG", name: "Engineering" },
        { key: "DES", name: "Design" },
      ]);
    });
  });

  describe("getIssueTypes", () => {
    test("should return default issue types", async () => {
      const types = await backend.getIssueTypes();
      expect(types).toEqual(["Task", "Story", "Bug", "Epic", "Feature", "Improvement"]);
    });
  });
});

describe("TrelloBackend", () => {
  let backend: TrelloBackend;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    backend = new TrelloBackend({ apiKey: "test-key", apiToken: "test-token" });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: unknown) {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  }

  test("should have correct name", () => {
    expect(backend.name).toBe("Trello");
  });

  test("should not support issue types", () => {
    expect(backend.supportsIssueTypes).toBe(false);
  });

  test("should not support epic linking", () => {
    expect(backend.supportsEpicLinking).toBe(false);
  });

  describe("createTask", () => {
    test("should create a card via Trello API", async () => {
      let callCount = 0;
      (globalThis as any).fetch = async () => {
        callCount++;
        if (callCount === 1) {
          // boards query
          return new Response(
            JSON.stringify([
              { id: "board-1", name: "Engineering", shortUrl: "https://trello.com/b/abc" },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (callCount === 2) {
          // lists query
          return new Response(JSON.stringify([{ id: "list-1", name: "To Do" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // create card
        return new Response(
          JSON.stringify({
            id: "card-1",
            shortLink: "ABC123",
            url: "https://trello.com/c/ABC123",
            name: "Add auth",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await backend.createTask("Add auth", "Implement OAuth", "Story");

      expect(result.key).toBe("ABC123");
      expect(result.url).toBe("https://trello.com/c/ABC123");
    });

    test("should use specified board id", async () => {
      let callCount = 0;
      (globalThis as any).fetch = async () => {
        callCount++;
        if (callCount === 1) {
          // lists query for specified board
          return new Response(JSON.stringify([{ id: "list-2", name: "Backlog" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // create card
        return new Response(
          JSON.stringify({
            id: "card-2",
            shortLink: "DEF456",
            url: "https://trello.com/c/DEF456",
            name: "Task",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await backend.createTask("Task", "Desc", "Task", "board-2");

      expect(result.key).toBe("DEF456");
    });
  });

  describe("createSubtask", () => {
    test("should add checklist item to parent card", async () => {
      let callCount = 0;
      (globalThis as any).fetch = async () => {
        callCount++;
        if (callCount === 1) {
          // get card
          return new Response(
            JSON.stringify({
              id: "card-1",
              shortLink: "ABC123",
              url: "https://trello.com/c/ABC123",
              name: "Parent",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (callCount === 2) {
          // get checklists
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (callCount === 3) {
          // create checklist
          return new Response(JSON.stringify({ id: "checklist-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // create checkItem
        return new Response(JSON.stringify({ id: "item-1", name: "Subtask: Details" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const result = await backend.createSubtask("ABC123", "Subtask", "Details");

      expect(result.key).toBe("ABC123-item-1");
      expect(result.url).toBe("https://trello.com/c/ABC123");
    });
  });

  describe("linkToEpic", () => {
    test("should add epic card as attachment", async () => {
      let callCount = 0;
      (globalThis as any).fetch = async () => {
        callCount++;
        if (callCount === 1) {
          // get story card
          return new Response(
            JSON.stringify({
              id: "story-1",
              shortLink: "STORY1",
              url: "https://trello.com/c/STORY1",
              name: "Story",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (callCount === 2) {
          // get epic card
          return new Response(
            JSON.stringify({
              id: "epic-1",
              shortLink: "EPIC1",
              url: "https://trello.com/c/EPIC1",
              name: "Epic",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // add attachment
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      await expect(backend.linkToEpic("STORY1", "EPIC1")).resolves.toBeUndefined();
    });
  });

  describe("getProjects", () => {
    test("should return boards as projects", async () => {
      mockFetch([
        { id: "board-1", name: "Engineering", shortUrl: "https://trello.com/b/abc" },
        { id: "board-2", name: "Design", shortUrl: "https://trello.com/b/def" },
      ]);

      const projects = await backend.getProjects();
      expect(projects).toEqual([
        { key: "board-1", name: "Engineering" },
        { key: "board-2", name: "Design" },
      ]);
    });
  });

  describe("getIssueTypes", () => {
    test("should return default issue types", async () => {
      const types = await backend.getIssueTypes();
      expect(types).toEqual(["Task", "Story", "Bug", "Epic"]);
    });
  });
});

describe("AzureDevOpsBackend", () => {
  let backend: AzureDevOpsBackend;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    backend = new AzureDevOpsBackend({
      organization: "test-org",
      pat: "test-pat",
      defaultProject: "TestProject",
    });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: unknown) {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  }

  test("should have correct name", () => {
    expect(backend.name).toBe("Azure DevOps");
  });

  test("should support issue types", () => {
    expect(backend.supportsIssueTypes).toBe(true);
  });

  test("should support epic linking", () => {
    expect(backend.supportsEpicLinking).toBe(true);
  });

  describe("createTask", () => {
    test("should create a work item via Azure DevOps API with HTML description", async () => {
      let requestBody: Array<{ path?: string; value?: string }> | undefined;
      (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
        requestBody = JSON.parse(init?.body as string) as Array<{ path?: string; value?: string }>;
        return new Response(
          JSON.stringify({
            id: 123,
            url: "https://dev.azure.com/test-org/_apis/wit/workItems/123",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await backend.createTask(
        "Add auth",
        "## Summary\n\n**Bold** detail",
        "User Story",
      );

      expect(result.key).toBe("123");
      const descriptionField = requestBody?.find(
        (op) => op.path === "/fields/System.Description",
      )?.value;
      expect(descriptionField).toContain("<h2>Summary</h2>");
      expect(descriptionField).toContain("<strong>Bold</strong>");
      expect(descriptionField).not.toContain("**Bold**");
    });

    test("should create a work item via Azure DevOps API", async () => {
      mockFetch({
        id: 123,
        url: "https://dev.azure.com/test-org/_apis/wit/workItems/123",
      });

      const result = await backend.createTask("Add auth", "Implement OAuth login", "User Story");

      expect(result.key).toBe("123");
      expect(result.url).toBe("https://dev.azure.com/test-org/TestProject/_workitems/edit/123");
    });

    test("should use specified project", async () => {
      mockFetch({
        id: 456,
        url: "https://dev.azure.com/test-org/_apis/wit/workItems/456",
      });

      const result = await backend.createTask(
        "Design system",
        "Create tokens",
        "Task",
        "OtherProject",
      );

      expect(result.key).toBe("456");
      expect(result.url).toBe("https://dev.azure.com/test-org/OtherProject/_workitems/edit/456");
    });
  });

  describe("createSubtask", () => {
    test("should create a subtask linked to parent", async () => {
      mockFetch({
        id: 789,
        url: "https://dev.azure.com/test-org/_apis/wit/workItems/789",
      });

      const result = await backend.createSubtask("123", "Subtask", "Details");

      expect(result.key).toBe("789");
    });

    test("should throw when parent key is not a valid work item ID", async () => {
      expect(backend.createSubtask("not-a-number", "Subtask", "Details")).rejects.toThrow(
        "Parent work item not found: not-a-number",
      );
    });
  });

  describe("linkToEpic", () => {
    test("should link story to epic via parent relationship", async () => {
      mockFetch({
        id: 100,
        url: "https://dev.azure.com/test-org/_apis/wit/workItems/100",
      });

      await expect(backend.linkToEpic("100", "200")).resolves.toBeUndefined();
    });
  });

  describe("getProjects", () => {
    test("should return projects", async () => {
      mockFetch({
        value: [
          { id: "proj-1", name: "Project A" },
          { id: "proj-2", name: "Project B" },
        ],
      });

      const projects = await backend.getProjects();
      expect(projects).toEqual([
        { key: "Project A", name: "Project A" },
        { key: "Project B", name: "Project B" },
      ]);
    });
  });

  describe("getIssueTypes", () => {
    test("should return work item types", async () => {
      mockFetch({
        value: [
          { name: "User Story", description: "A user story" },
          { name: "Task", description: "A task" },
          { name: "Bug", description: "A bug" },
        ],
      });

      const types = await backend.getIssueTypes();
      expect(types).toEqual(["User Story", "Task", "Bug"]);
    });
  });
});

describe("AsanaBackend", () => {
  let backend: AsanaBackend;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    backend = new AsanaBackend({ apiToken: "test-token" });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: unknown) {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ data: response }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  }

  test("should have correct name", () => {
    expect(backend.name).toBe("Asana");
  });

  test("should not support issue types", () => {
    expect(backend.supportsIssueTypes).toBe(false);
  });

  test("should support epic linking", () => {
    expect(backend.supportsEpicLinking).toBe(true);
  });

  describe("createTask", () => {
    test("should create a task via Asana API with html_notes", async () => {
      let requestBody: { data?: { html_notes?: string } } | undefined;
      (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
        requestBody = JSON.parse(init?.body as string) as { data?: { html_notes?: string } };
        return new Response(
          JSON.stringify({
            data: {
              gid: "task-123",
              name: "Add auth",
              permalink_url: "https://app.asana.com/0/0/123",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await backend.createTask("Add auth", "## Summary\n\n**Bold** detail", "Task");

      expect(result.key).toBe("task-123");
      expect(requestBody?.data?.html_notes).toContain("<body>");
      expect(requestBody?.data?.html_notes).toContain("<h2>Summary</h2>");
      expect(requestBody?.data?.html_notes).toContain("<strong>Bold</strong>");
      expect(requestBody?.data?.html_notes).not.toContain("**Bold**");
    });

    test("should use specified project", async () => {
      mockFetch({
        gid: "task-456",
        name: "Design system",
        permalink_url: "https://app.asana.com/0/0/456",
      });

      const result = await backend.createTask("Design system", "Create tokens", "Task", "proj-1");

      expect(result.key).toBe("task-456");
    });
  });

  describe("createSubtask", () => {
    test("should create a subtask linked to parent", async () => {
      let callCount = 0;
      (globalThis as any).fetch = async () => {
        callCount++;
        if (callCount === 1) {
          // get parent task
          return new Response(
            JSON.stringify({
              data: {
                gid: "parent-123",
                name: "Parent",
                permalink_url: "https://app.asana.com/0/0/123",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // create subtask
        return new Response(
          JSON.stringify({
            data: {
              gid: "sub-789",
              name: "Subtask",
              permalink_url: "https://app.asana.com/0/0/789",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await backend.createSubtask("parent-123", "Subtask", "Details");

      expect(result.key).toBe("sub-789");
    });

    test("should throw when parent task not found", async () => {
      (globalThis as any).fetch = async () =>
        new Response(JSON.stringify({ errors: [{ message: "Task not found" }] }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });

      expect(backend.createSubtask("not-found", "Subtask", "Details")).rejects.toThrow(
        "Parent task not found: not-found",
      );
    });
  });

  describe("linkToEpic", () => {
    test("should link story to epic via parent relationship", async () => {
      mockFetch({
        gid: "story-1",
        name: "Story",
        permalink_url: "https://app.asana.com/0/0/1",
      });

      await expect(backend.linkToEpic("story-1", "epic-1")).resolves.toBeUndefined();
    });
  });

  describe("getProjects", () => {
    test("should return projects", async () => {
      mockFetch([
        { gid: "proj-1", name: "Engineering" },
        { gid: "proj-2", name: "Design" },
      ]);

      const projects = await backend.getProjects();
      expect(projects).toEqual([
        { key: "proj-1", name: "Engineering" },
        { key: "proj-2", name: "Design" },
      ]);
    });
  });

  describe("getIssueTypes", () => {
    test("should return default issue types", async () => {
      const types = await backend.getIssueTypes();
      expect(types).toEqual(["Task", "Milestone"]);
    });
  });
});

describe("GitHubBackend", () => {
  let backend: GitHubBackend;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    backend = new GitHubBackend({ token: "test-token", owner: "test-org", repo: "test-repo" });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: unknown) {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  }

  test("should have correct name", () => {
    expect(backend.name).toBe("GitHub");
  });

  test("should support issue types", () => {
    expect(backend.supportsIssueTypes).toBe(true);
  });

  test("should not support epic linking", () => {
    expect(backend.supportsEpicLinking).toBe(false);
  });

  describe("createTask", () => {
    test("should create an issue via GitHub API", async () => {
      mockFetch({
        number: 42,
        html_url: "https://github.com/test-org/test-repo/issues/42",
        title: "Add auth",
        body: "Implement OAuth login",
      });

      const result = await backend.createTask("Add auth", "Implement OAuth login", "Story");

      expect(result.key).toBe("42");
      expect(result.url).toBe("https://github.com/test-org/test-repo/issues/42");
    });

    test("should map Bug issue type to bug label", async () => {
      mockFetch({
        number: 43,
        html_url: "https://github.com/test-org/test-repo/issues/43",
        title: "Fix crash",
        body: "App crashes on startup",
      });

      const result = await backend.createTask("Fix crash", "App crashes on startup", "Bug");

      expect(result.key).toBe("43");
    });
  });

  describe("createSubtask", () => {
    test("should create a subtask and add task list to parent", async () => {
      let callCount = 0;
      (globalThis as any).fetch = async () => {
        callCount++;
        if (callCount === 1) {
          // create subtask issue
          return new Response(
            JSON.stringify({
              number: 44,
              html_url: "https://github.com/test-org/test-repo/issues/44",
              title: "Subtask",
              body: "Details",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (callCount === 2) {
          // get parent issue
          return new Response(
            JSON.stringify({
              number: 42,
              html_url: "https://github.com/test-org/test-repo/issues/42",
              title: "Parent",
              body: "Parent description",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // update parent issue
        return new Response(
          JSON.stringify({
            number: 42,
            html_url: "https://github.com/test-org/test-repo/issues/42",
            title: "Parent",
            body: "Parent description\n\n## Subtasks\n- [ ] #44",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await backend.createSubtask("42", "Subtask", "Details");

      expect(result.key).toBe("44");
    });

    test("should throw when parent key is not a valid issue number", async () => {
      expect(backend.createSubtask("not-a-number", "Subtask", "Details")).rejects.toThrow(
        "Invalid parent issue number: not-a-number",
      );
    });
  });

  describe("linkToEpic", () => {
    test("should add epic reference to issue body", async () => {
      let callCount = 0;
      (globalThis as any).fetch = async () => {
        callCount++;
        if (callCount === 1) {
          // get story issue
          return new Response(
            JSON.stringify({
              number: 1,
              html_url: "https://github.com/test-org/test-repo/issues/1",
              title: "Story",
              body: "Description",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // update story issue
        return new Response(
          JSON.stringify({
            number: 1,
            html_url: "https://github.com/test-org/test-repo/issues/1",
            title: "Story",
            body: "Description\n\nPart of #100",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      await expect(backend.linkToEpic("1", "100")).resolves.toBeUndefined();
    });
  });

  describe("getProjects", () => {
    test("should return repositories as projects", async () => {
      mockFetch([
        { id: 1, name: "test-repo", full_name: "test-org/test-repo", owner: { login: "test-org" } },
        {
          id: 2,
          name: "other-repo",
          full_name: "test-org/other-repo",
          owner: { login: "test-org" },
        },
      ]);

      const projects = await backend.getProjects();
      expect(projects).toEqual([
        { key: "test-org/test-repo", name: "test-repo" },
        { key: "test-org/other-repo", name: "other-repo" },
      ]);
    });
  });

  describe("getIssueTypes", () => {
    test("should return default issue types", async () => {
      const types = await backend.getIssueTypes();
      expect(types).toEqual(["Task", "Story", "Bug", "Epic"]);
    });
  });
});
