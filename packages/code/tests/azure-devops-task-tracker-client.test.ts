import { describe, expect, test } from "bun:test";
import {
  AzureDevOpsTaskTrackerClient,
  parseAzureDevOpsWorkItemReference,
} from "../src/lib/trackers/azure-devops/azure-devops-task-tracker-client";
import type { AzureDevOpsClient, AzureDevOpsWorkItemDetail } from "@devintern/task-trackers";

function makeWorkItem(
  overrides: Partial<AzureDevOpsWorkItemDetail> = {},
): AzureDevOpsWorkItemDetail {
  return {
    id: 4211,
    url: "https://dev.azure.com/myorg/MyProject/_workitems/edit/4211",
    fields: {
      "System.Title": "Fix login bug",
      "System.Description": '<p>Steps with <a href="https://example.com/spec">spec</a></p>',
      "System.State": "New",
      "System.WorkItemType": "User Story",
      "System.AssignedTo": { displayName: "Ada" },
      "System.CreatedBy": { displayName: "Grace" },
      "System.CreatedDate": "2026-01-01T00:00:00Z",
      "System.ChangedDate": "2026-01-02T00:00:00Z",
      "System.Tags": "bug; login",
    },
    relations: [],
    ...overrides,
  };
}

/** Inject a stubbed AzureDevOpsClient into the adapter (bypasses HTTP). */
function makeAdapter(stub: Partial<AzureDevOpsClient>): AzureDevOpsTaskTrackerClient {
  const adapter = new AzureDevOpsTaskTrackerClient("myorg", "pat", "MyProject");
  (adapter as unknown as { azureClient: Partial<AzureDevOpsClient> }).azureClient = stub;
  return adapter;
}

describe("parseAzureDevOpsWorkItemReference", () => {
  test("accepts bare numeric IDs", () => {
    expect(parseAzureDevOpsWorkItemReference("4211")).toBe("4211");
    expect(parseAzureDevOpsWorkItemReference("#4211")).toBe("4211");
  });

  test("extracts ID from work item URLs", () => {
    expect(
      parseAzureDevOpsWorkItemReference(
        "https://dev.azure.com/myorg/MyProject/_workitems/edit/4211",
      ),
    ).toBe("4211");
  });

  test("returns null for other values", () => {
    expect(parseAzureDevOpsWorkItemReference("PROJ-123")).toBeNull();
    expect(parseAzureDevOpsWorkItemReference("./task.md")).toBeNull();
  });
});

describe("AzureDevOpsTaskTrackerClient.getTask", () => {
  test("normalizes work item fields into Task", async () => {
    const adapter = makeAdapter({ getWorkItemDetail: async () => makeWorkItem() });

    const task = await adapter.getTask("4211");

    expect(task.key).toBe("4211");
    expect(task.summary).toBe("Fix login bug");
    expect(task.status).toBe("New");
    expect(task.issueType).toBe("User Story");
    expect(task.assignee).toBe("Ada");
    expect(task.reporter).toBe("Grace");
    expect(task.labels).toEqual(["bug", "login"]);
    expect(task.renderedDescription).toContain("<p>");
    expect(task.description).toContain("Steps with");
  });
});

describe("AzureDevOpsTaskTrackerClient.transitionStatus", () => {
  test("updates System.State", async () => {
    let movedTo = "";
    const adapter = makeAdapter({
      updateWorkItemState: async (_id: number, state: string) => {
        movedTo = state;
      },
    });

    await adapter.transitionStatus("4211", "Active");
    expect(movedTo).toBe("Active");
  });

  test("wraps API errors with actionable message", async () => {
    const adapter = makeAdapter({
      updateWorkItemState: async () => {
        throw new Error("Azure DevOps API error (400): invalid state");
      },
    });

    await expect(adapter.transitionStatus("4211", "Bogus")).rejects.toThrow(
      'Failed to move work item 4211 to state "Bogus"',
    );
  });
});

describe("AzureDevOpsTaskTrackerClient.getComments", () => {
  test("filters devintern comments and strips HTML", async () => {
    const adapter = makeAdapter({
      getComments: async () => [
        {
          id: 1,
          text: "<p>Human <b>question</b></p>",
          createdBy: { displayName: "Ada" },
          createdDate: "2026-01-01T00:00:00Z",
        },
        {
          id: 2,
          text: "<h3>Implementation Completed by @devintern/code</h3>",
          createdBy: { displayName: "Bot" },
          createdDate: "2026-01-02T00:00:00Z",
        },
      ],
    });

    const comments = await adapter.getComments("4211");

    expect(comments.length).toBe(1);
    expect(comments[0].author).toBe("Ada");
    expect(comments[0].body).toBe("Human question");
  });
});

describe("AzureDevOpsTaskTrackerClient estimation", () => {
  test("defaults to the StoryPoints field", async () => {
    const adapter = makeAdapter({});
    expect(await adapter.discoverEstimationField()).toBe("Microsoft.VSTS.Scheduling.StoryPoints");
  });

  test("updateEstimation patches the field", async () => {
    const updates: Array<[number, string, unknown]> = [];
    const adapter = makeAdapter({
      updateWorkItemField: async (id: number, field: string, value: unknown) => {
        updates.push([id, field, value]);
      },
    });

    await adapter.updateEstimation("4211", "Microsoft.VSTS.Scheduling.StoryPoints", 8);

    expect(updates).toEqual([[4211, "Microsoft.VSTS.Scheduling.StoryPoints", 8]]);
  });

  test("findEstimationComment locates prior estimation comment", async () => {
    const adapter = makeAdapter({
      getComments: async () => [
        {
          id: 9,
          text: "<h3>🤖 Automated Story Points Estimation</h3>",
          createdDate: "2026-01-03T00:00:00Z",
        },
      ],
    });

    const found = await adapter.findEstimationComment("4211");
    expect(found).toEqual({ commentId: "9", created: "2026-01-03T00:00:00Z" });
  });
});

describe("AzureDevOpsTaskTrackerClient related work items", () => {
  test("maps hierarchy relations to related issues", async () => {
    const adapter = makeAdapter({
      getWorkItemDetail: async (key: string) =>
        key === "100"
          ? makeWorkItem({
              id: 100,
              fields: {
                "System.Title": "Parent story",
                "System.State": "Active",
                "System.WorkItemType": "Feature",
              },
            })
          : makeWorkItem(),
    });

    const task = await adapter.getTask("4211");
    (task.raw as AzureDevOpsWorkItemDetail).relations = [
      {
        rel: "System.LinkTypes.Hierarchy-Reverse",
        url: "https://dev.azure.com/myorg/_apis/wit/workItems/100",
      },
    ];

    const related = await adapter.getRelatedWorkItems(task);

    expect(related.length).toBe(1);
    expect(related[0].key).toBe("100");
    expect(related[0].summary).toBe("Parent story");
    expect(related[0].linkType).toBe("parent");
  });
});
