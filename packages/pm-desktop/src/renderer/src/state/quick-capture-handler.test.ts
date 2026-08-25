import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";
import { getDefaultIssueType } from "../lib/issue-types.ts";
import { queryClient } from "../lib/query-client.ts";
import { qk } from "../queries/keys.ts";
import { resetProjectStore, useProjectStore } from "./project-store.ts";
import { handleQuickCaptureEvent } from "./quick-capture-handler.ts";
import { resetTicketIdCounter } from "./ticket-workspaces.ts";
import { resetTicketWorkspacesStore, useTicketWorkspacesStore } from "./ticket-workspaces-store.ts";

const status = (overrides: Partial<ProjectStatus> = {}): ProjectStatus => ({
  projectDir: "/repo",
  configured: true,
  isGitRepository: true,
  defaultProjectKey: "DEV",
  ...overrides,
});

beforeEach(() => {
  resetProjectStore();
  resetTicketWorkspacesStore();
  resetTicketIdCounter();
  queryClient.clear();
});

afterEach(() => {
  resetProjectStore();
  resetTicketWorkspacesStore();
  queryClient.clear();
});

describe("handleQuickCaptureEvent", () => {
  test("no-op without a loaded project", () => {
    expect(handleQuickCaptureEvent({ text: "note", sourceType: "prompt" })).toBe(false);
    expect(useTicketWorkspacesStore.getState().tickets).toHaveLength(0);
  });

  test("no-op when the folder is not a git repository", () => {
    useProjectStore.getState().setStatus(status({ isGitRepository: false }));
    expect(handleQuickCaptureEvent({ text: "note", sourceType: "prompt" })).toBe(false);
    expect(useTicketWorkspacesStore.getState().tickets).toHaveLength(0);
  });

  test("no-op while the project is not configured yet", () => {
    useProjectStore.getState().setStatus(status({ configured: false }));
    expect(handleQuickCaptureEvent({ text: "note", sourceType: "prompt" })).toBe(false);
    expect(useTicketWorkspacesStore.getState().tickets).toHaveLength(0);
  });

  test("opens a fresh active ticket prefilled from the capture", () => {
    useProjectStore.getState().setStatus(status());
    const opened = handleQuickCaptureEvent({
      text: "https://www.figma.com/design/A1",
      sourceType: "figma",
    });
    expect(opened).toBe(true);
    const state = useTicketWorkspacesStore.getState();
    expect(state.tickets).toHaveLength(1);
    expect(state.activeTicketId).toBe(state.tickets[0]!.id);
    const composer = state.tickets[0]!.composer;
    // Capture lands on its inferred source tab, ready to type elsewhere.
    expect(composer.sourceType).toBe("figma");
    expect(composer.sourceContent.figma).toBe("https://www.figma.com/design/A1");
    expect(composer.sourceContent.prompt).toBe("");
    // Project defaults come from the loaded status + fallback issue types.
    expect(composer.projectKey).toBe("DEV");
    expect(composer.issueType).toBe(getDefaultIssueType(["Task", "Story", "Bug", "Epic"]));
  });

  test("keeps existing ticket workspaces and activates only the fresh one", () => {
    useProjectStore.getState().setStatus(status());
    useTicketWorkspacesStore.getState().openTicket("existing", {
      ...useTicketWorkspacesStore.getState().tickets[0]?.composer,
      projectKey: "DEV",
      issueType: "Task",
      sourceType: "prompt",
      sourceContent: { figma: "", log: "", prompt: "" },
      extraInstructions: "",
      promptStyle: "pm",
      epicKey: "",
      labels: [],
      attachments: [],
      decompose: false,
    });
    handleQuickCaptureEvent({ text: null, sourceType: "prompt" });
    const state = useTicketWorkspacesStore.getState();
    expect(state.tickets.map((t) => t.id)).toContain("existing");
    expect(state.activeTicketId).not.toBe("existing");
  });

  test("uses seeded issue types from the query cache for the default key", () => {
    useProjectStore.getState().setStatus(status());
    queryClient.setQueryData(qk.issueTypes("/repo", "DEV"), ["Story", "Bug"]);
    handleQuickCaptureEvent({ text: null, sourceType: "log" });
    const composer = useTicketWorkspacesStore.getState().tickets[0]!.composer;
    expect(composer.issueType).toBe(getDefaultIssueType(["Story", "Bug"]));
  });
});
