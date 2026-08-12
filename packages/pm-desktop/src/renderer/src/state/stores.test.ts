import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";
import { resetProjectStore, useProjectStore } from "./project-store.ts";
import { resetTicketWorkspacesStore, useTicketWorkspacesStore } from "./ticket-workspaces-store.ts";
import {
  anyTicketBusy,
  isChromeBusy,
  isContextBusy,
  isTicketActionBlocked,
  useActiveTicket,
  useActiveTicketBusy,
  useAnyTicketBusy,
  useComposerBusy,
} from "./selectors.ts";
import { createTicketWorkspace } from "./ticket-workspaces.ts";
import { initialOutputState } from "./app-store.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const status = (overrides: Partial<ProjectStatus> = {}): ProjectStatus => ({
  projectDir: "/repo",
  configured: true,
  isGitRepository: true,
  ...overrides,
});

beforeEach(() => {
  resetProjectStore();
  resetTicketWorkspacesStore();
});
afterEach(() => {
  resetProjectStore();
  resetTicketWorkspacesStore();
});

describe("useProjectStore", () => {
  test("starts with loadingProject true and a null status", () => {
    expect(useProjectStore.getState().status).toBeNull();
    expect(useProjectStore.getState().loadingProject).toBe(true);
    expect(useProjectStore.getState().updatingFromRemote).toBe(false);
    expect(useProjectStore.getState().chromeError).toBeNull();
  });

  test("setStatus / setLoadingProject / setUpdatingFromRemote / setChromeError mutate state", () => {
    useProjectStore.getState().setStatus(status({ projectDir: "/a" }));
    useProjectStore.getState().setLoadingProject(false);
    useProjectStore.getState().setUpdatingFromRemote(true);
    useProjectStore.getState().setChromeError("boom");
    const s = useProjectStore.getState();
    expect(s.status?.projectDir).toBe("/a");
    expect(s.loadingProject).toBe(false);
    expect(s.updatingFromRemote).toBe(true);
    expect(s.chromeError).toBe("boom");
  });

  test("clearProject resets status + flags + error", () => {
    useProjectStore.getState().setStatus(status());
    useProjectStore.getState().setChromeError("boom");
    useProjectStore.getState().setUpdatingFromRemote(true);
    useProjectStore.getState().clearProject();
    const s = useProjectStore.getState();
    expect(s.status).toBeNull();
    expect(s.chromeError).toBeNull();
    expect(s.updatingFromRemote).toBe(false);
    expect(s.loadingProject).toBe(false);
  });
});

describe("useTicketWorkspacesStore actions forward into the reducer", () => {
  test("projectLoaded opens one active ticket", () => {
    useTicketWorkspacesStore.getState().projectLoaded({
      projectKey: "DEV",
      sourceType: "prompt",
      sourceContent: { figma: "", log: "", prompt: "" },
      extraInstructions: "",
      promptStyle: "pm",
      issueType: "Task",
      epicKey: "",
      labels: [],
      attachments: [],
      decompose: false,
    });
    const s = useTicketWorkspacesStore.getState();
    expect(s.tickets).toHaveLength(1);
    expect(s.activeTicketId).toBe(s.tickets[0]!.id);
  });

  test("openTicket / activateTicket / closeTicket round-trip", () => {
    useTicketWorkspacesStore.getState().openTicket("t1", {
      projectKey: "DEV",
      sourceType: "prompt",
      sourceContent: { figma: "", log: "", prompt: "" },
      extraInstructions: "",
      promptStyle: "pm",
      issueType: "Task",
      epicKey: "",
      labels: [],
      attachments: [],
      decompose: false,
    });
    useTicketWorkspacesStore.getState().openTicket("t2", {
      projectKey: "DEV",
      sourceType: "prompt",
      sourceContent: { figma: "", log: "", prompt: "" },
      extraInstructions: "",
      promptStyle: "pm",
      issueType: "Bug",
      epicKey: "",
      labels: [],
      attachments: [],
      decompose: false,
    });
    useTicketWorkspacesStore.getState().activateTicket("t1");
    expect(useTicketWorkspacesStore.getState().activeTicketId).toBe("t1");
    useTicketWorkspacesStore.getState().closeTicket("t1");
    expect(useTicketWorkspacesStore.getState().tickets).toHaveLength(1);
    expect(useTicketWorkspacesStore.getState().activeTicketId).toBe("t2");
  });

  test("patchComposer deep-merges sourceContent", () => {
    useTicketWorkspacesStore.getState().openTicket("t1", {
      projectKey: "DEV",
      sourceType: "prompt",
      sourceContent: { figma: "", log: "", prompt: "" },
      extraInstructions: "",
      promptStyle: "pm",
      issueType: "Task",
      epicKey: "",
      labels: [],
      attachments: [],
      decompose: false,
    });
    useTicketWorkspacesStore.getState().patchComposer("t1", {
      sourceContent: { figma: "", log: "", prompt: "hello" },
    });
    const composer = useTicketWorkspacesStore.getState().tickets[0]!.composer;
    expect(composer.sourceContent.prompt).toBe("hello");
    // Untouched tabs survive the partial patch (deep-merged in the reducer).
    expect(composer.sourceContent.figma).toBe("");
  });

  test("routeAgentChunk ignores chunks for unknown requestIds", () => {
    useTicketWorkspacesStore.getState().openTicket("t1", {
      projectKey: "DEV",
      sourceType: "prompt",
      sourceContent: { figma: "", log: "", prompt: "" },
      extraInstructions: "",
      promptStyle: "pm",
      issueType: "Task",
      epicKey: "",
      labels: [],
      attachments: [],
      decompose: false,
    });
    useTicketWorkspacesStore.getState().applyOutputAction("t1", {
      type: "generate-started",
      requestId: "req-1",
    });
    useTicketWorkspacesStore.getState().routeAgentChunk("orphan", "ignored");
    useTicketWorkspacesStore.getState().routeAgentChunk("req-1", "chunk");
    const out = useTicketWorkspacesStore.getState().tickets[0]!.output;
    expect(out.agentLog).toBe("chunk");
  });
});

describe("cross-store selectors", () => {
  test("anyTicketBusy reflects any in-flight phase", () => {
    const idle = createTicketWorkspace("a");
    const generating = {
      ...createTicketWorkspace("b"),
      output: { ...initialOutputState, phase: "generating" as const },
    };
    expect(anyTicketBusy([idle])).toBe(false);
    expect(anyTicketBusy([idle, generating])).toBe(true);
  });

  test("isChromeBusy is only loadingProject / updatingFromRemote", () => {
    useProjectStore.getState().setLoadingProject(false);
    expect(isChromeBusy()).toBe(false);
    useProjectStore.getState().setLoadingProject(true);
    expect(isChromeBusy()).toBe(true);
    useProjectStore.getState().setLoadingProject(false);
    useProjectStore.getState().setUpdatingFromRemote(true);
    expect(isChromeBusy()).toBe(true);
    useProjectStore.getState().setUpdatingFromRemote(false);
    // A busy ticket must not trip chrome-only busy (DEV-66).
    useTicketWorkspacesStore.setState({
      tickets: [
        { ...createTicketWorkspace("b"), output: { ...initialOutputState, phase: "editing" } },
      ],
      activeTicketId: "b",
    });
    expect(isChromeBusy()).toBe(false);
  });

  test("isContextBusy combines chrome flags + any ticket busy", () => {
    // Default state has loadingProject=true (mount through restore); clear it first.
    useProjectStore.getState().setLoadingProject(false);
    expect(isContextBusy()).toBe(false);
    useProjectStore.getState().setLoadingProject(true);
    expect(isContextBusy()).toBe(true);
    useProjectStore.getState().setLoadingProject(false);
    useProjectStore.getState().setUpdatingFromRemote(true);
    expect(isContextBusy()).toBe(true);
    useProjectStore.getState().setUpdatingFromRemote(false);
    // A busy ticket trips project-chrome context busy (switch project / Update).
    useTicketWorkspacesStore.setState({
      tickets: [
        { ...createTicketWorkspace("b"), output: { ...initialOutputState, phase: "editing" } },
      ],
      activeTicketId: "b",
    });
    expect(isContextBusy()).toBe(true);
  });

  test("ticket A busy does not block Generate / Create on idle ticket B (DEV-66)", () => {
    useProjectStore.getState().setLoadingProject(false);
    useProjectStore.getState().setUpdatingFromRemote(false);
    const ticketA = {
      ...createTicketWorkspace("a"),
      output: { ...initialOutputState, phase: "generating" as const, activeRequestId: "r-a" },
    };
    const ticketB = createTicketWorkspace("b");
    useTicketWorkspacesStore.setState({
      tickets: [ticketA, ticketB],
      activeTicketId: ticketB.id,
    });

    // Background run still counts for project chrome (Update, switch project).
    expect(anyTicketBusy([ticketA, ticketB])).toBe(true);
    expect(isContextBusy()).toBe(true);

    // Idle active ticket stays actionable for Generate / Create / Edit / Decompose.
    expect(isTicketActionBlocked(ticketB)).toBe(false);
    // Own in-flight ticket stays blocked.
    expect(isTicketActionBlocked(ticketA)).toBe(true);
  });

  test("isTicketActionBlocked still true under chrome busy on an idle ticket", () => {
    useProjectStore.getState().setLoadingProject(false);
    const idle = createTicketWorkspace("idle");
    expect(isTicketActionBlocked(idle)).toBe(false);
    useProjectStore.getState().setLoadingProject(true);
    expect(isTicketActionBlocked(idle)).toBe(true);
    useProjectStore.getState().setLoadingProject(false);
    useProjectStore.getState().setUpdatingFromRemote(true);
    expect(isTicketActionBlocked(idle)).toBe(true);
  });

  test("useActiveTicket / useActiveTicketBusy / useAnyTicketBusy / useComposerBusy read the stores in SSR", () => {
    useProjectStore.setState({
      status: status(),
      loadingProject: false,
      updatingFromRemote: false,
      chromeError: null,
    });
    const ticket = createTicketWorkspace("act-1");
    useTicketWorkspacesStore.setState({
      tickets: [ticket],
      activeTicketId: ticket.id,
    });

    const Probe = () => {
      const active = useActiveTicket();
      const activeBusy = useActiveTicketBusy();
      const anyBusy = useAnyTicketBusy();
      const composerBusy = useComposerBusy();
      return createElement(
        "div",
        null,
        `active=${active?.id ?? "none"};activeBusy=${activeBusy};anyBusy=${anyBusy};composerBusy=${composerBusy}`,
      );
    };
    const html = renderToStaticMarkup(createElement(Probe));
    expect(html).toContain("active=act-1");
    expect(html).toContain("activeBusy=false");
    expect(html).toContain("anyBusy=false");
    expect(html).toContain("composerBusy=false");
  });

  test("useComposerBusy is false when only a background ticket is busy", () => {
    useProjectStore.setState({
      status: status(),
      loadingProject: false,
      updatingFromRemote: false,
      chromeError: null,
    });
    const generating = {
      ...createTicketWorkspace("bg"),
      output: { ...initialOutputState, phase: "generating" as const, activeRequestId: "r-bg" },
    };
    const idle = createTicketWorkspace("fg");
    useTicketWorkspacesStore.setState({
      tickets: [generating, idle],
      activeTicketId: idle.id,
    });

    const Probe = () => {
      const activeBusy = useActiveTicketBusy();
      const anyBusy = useAnyTicketBusy();
      const composerBusy = useComposerBusy();
      return createElement(
        "div",
        null,
        `activeBusy=${activeBusy};anyBusy=${anyBusy};composerBusy=${composerBusy}`,
      );
    };
    const html = renderToStaticMarkup(createElement(Probe));
    expect(html).toContain("activeBusy=false");
    expect(html).toContain("anyBusy=true");
    expect(html).toContain("composerBusy=false");
  });
});
