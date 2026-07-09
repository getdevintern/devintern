import { describe, expect, test } from "bun:test";
import {
  AsanaTaskTrackerClient,
  parseAsanaTaskReference,
} from "../src/lib/trackers/asana/asana-task-tracker-client";
import type { AsanaClient, AsanaTaskDetail } from "@devintern/task-trackers";

function makeTask(overrides: Partial<AsanaTaskDetail> = {}): AsanaTaskDetail {
  return {
    gid: "1200000000000001",
    name: "Fix login bug",
    permalink_url: "https://app.asana.com/0/1200000000000000/1200000000000001",
    notes: "Steps in https://example.com/spec",
    completed: false,
    assignee: { name: "Ada" },
    created_by: { name: "Grace" },
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-02T00:00:00Z",
    tags: [{ name: "bug" }],
    memberships: [
      {
        project: { gid: "1200000000000000", name: "Webapp" },
        section: { gid: "s1", name: "To Do" },
      },
    ],
    custom_fields: [{ gid: "field-7", name: "Story Points", type: "number", number_value: null }],
    ...overrides,
  };
}

/** Inject a stubbed AsanaClient into the adapter (bypasses HTTP). */
function makeAdapter(
  stub: Partial<AsanaClient>,
  options?: { defaultProjectGid?: string; storyPointsFieldName?: string },
): AsanaTaskTrackerClient {
  const adapter = new AsanaTaskTrackerClient("pat", options);
  (adapter as unknown as { asanaClient: Partial<AsanaClient> }).asanaClient = stub;
  return adapter;
}

describe("parseAsanaTaskReference", () => {
  test("accepts bare GIDs", () => {
    expect(parseAsanaTaskReference("1200000000000001")).toBe("1200000000000001");
  });

  test("extracts GID from legacy URLs", () => {
    expect(
      parseAsanaTaskReference("https://app.asana.com/0/1200000000000000/1200000000000001"),
    ).toBe("1200000000000001");
    expect(
      parseAsanaTaskReference("https://app.asana.com/0/1200000000000000/1200000000000001/f"),
    ).toBe("1200000000000001");
  });

  test("extracts GID from modern task URLs", () => {
    expect(
      parseAsanaTaskReference("https://app.asana.com/1/12345/project/6789/task/1200000000000001"),
    ).toBe("1200000000000001");
  });

  test("returns null for other values", () => {
    expect(parseAsanaTaskReference("PROJ-123")).toBeNull();
    expect(parseAsanaTaskReference("./task.md")).toBeNull();
    expect(parseAsanaTaskReference("123")).toBeNull();
  });
});

describe("AsanaTaskTrackerClient.getTask", () => {
  test("normalizes task detail into Task", async () => {
    const adapter = makeAdapter({ getTaskDetail: async () => makeTask() });

    const task = await adapter.getTask("1200000000000001");

    expect(task.key).toBe("1200000000000001");
    expect(task.summary).toBe("Fix login bug");
    expect(task.status).toBe("To Do");
    expect(task.assignee).toBe("Ada");
    expect(task.reporter).toBe("Grace");
    expect(task.labels).toEqual(["bug"]);
  });

  test("reports Completed status for completed tasks", async () => {
    const adapter = makeAdapter({ getTaskDetail: async () => makeTask({ completed: true }) });

    const task = await adapter.getTask("1200000000000001");
    expect(task.status).toBe("Completed");
  });
});

describe("AsanaTaskTrackerClient.transitionStatus", () => {
  test("marks the task complete for done statuses", async () => {
    const completedCalls: boolean[] = [];
    const adapter = makeAdapter({
      setCompleted: async (_gid: string, completed: boolean) => {
        completedCalls.push(completed);
      },
    });

    await adapter.transitionStatus("1200000000000001", "Done");
    expect(completedCalls).toEqual([true]);
  });

  test("moves the task to a matched section", async () => {
    let movedTo = "";
    const adapter = makeAdapter({
      getTaskDetail: async () => makeTask(),
      getSections: async () => [
        { gid: "s1", name: "To Do" },
        { gid: "s2", name: "In Progress" },
      ],
      moveTaskToSection: async (sectionGid: string) => {
        movedTo = sectionGid;
      },
    });

    await adapter.transitionStatus("1200000000000001", "in progress");
    expect(movedTo).toBe("s2");
  });

  test("lists available sections when target not found", async () => {
    const adapter = makeAdapter({
      getTaskDetail: async () => makeTask(),
      getSections: async () => [
        { gid: "s1", name: "To Do" },
        { gid: "s2", name: "Done" },
      ],
    });

    await expect(adapter.transitionStatus("1200000000000001", "Bogus")).rejects.toThrow(
      "Available sections: To Do, Done",
    );
  });

  test("errors when no project can be resolved", async () => {
    const adapter = makeAdapter({
      getTaskDetail: async () => makeTask({ memberships: [] }),
    });

    await expect(adapter.transitionStatus("1200000000000001", "In Progress")).rejects.toThrow(
      "Cannot resolve a project",
    );
  });
});

describe("AsanaTaskTrackerClient.getComments", () => {
  test("filters devintern automation stories", async () => {
    const adapter = makeAdapter({
      getStories: async () => [
        { gid: "a", text: "Human question", created_by: { name: "Ada" }, created_at: "2026-01-01" },
        {
          gid: "b",
          text: "Implementation Completed by @devintern/code",
          created_by: { name: "Bot" },
          created_at: "2026-01-02",
        },
      ],
    });

    const comments = await adapter.getComments("1200000000000001");

    expect(comments.length).toBe(1);
    expect(comments[0].author).toBe("Ada");
  });
});

describe("AsanaTaskTrackerClient estimation", () => {
  test("discovers a numeric custom field matching the configured name", async () => {
    const adapter = makeAdapter(
      { getTaskDetail: async () => makeTask() },
      { storyPointsFieldName: "story points" },
    );

    expect(await adapter.discoverEstimationField("1200000000000001")).toBe("field-7");
  });

  test("returns null without a configured field name", async () => {
    const adapter = makeAdapter({ getTaskDetail: async () => makeTask() });
    expect(await adapter.discoverEstimationField("1200000000000001")).toBeNull();
  });

  test("updateEstimation sets the custom field", async () => {
    const updates: Array<[string, string, unknown]> = [];
    const adapter = makeAdapter({
      updateCustomField: async (gid: string, field: string, value: unknown) => {
        updates.push([gid, field, value]);
      },
    });

    await adapter.updateEstimation("1200000000000001", "field-7", 5);
    expect(updates).toEqual([["1200000000000001", "field-7", 5]]);
  });
});

describe("AsanaTaskTrackerClient.searchTasks", () => {
  test("injects the default project gid when the query has none", async () => {
    let receivedFilters: unknown;
    const adapter = makeAdapter(
      {
        searchTasks: async (filters: unknown) => {
          receivedFilters = filters;
          return { tasks: [makeTask()], total: 1 };
        },
      },
      { defaultProjectGid: "1200000000000000" },
    );

    const result = await adapter.searchTasks('section:"To Do" completed:false');

    expect((receivedFilters as { projectGid: string }).projectGid).toBe("1200000000000000");
    expect(result.total).toBe(1);
    expect(result.tasks[0].key).toBe("1200000000000001");
  });
});
