import { describe, expect, test, beforeEach } from "bun:test";
import { initialComposerValues, type ComposerValues } from "../components/ComposerForm.tsx";
import {
  createTicketWorkspace,
  getActiveTicket,
  nextTicketId,
  pickActiveAfterClose,
  resetTicketIdCounter,
  ticketAgentStatus,
  ticketTitle,
  ticketWorkspacesReducer,
  initialTicketWorkspacesState,
  type TicketWorkspacesState,
} from "./ticket-workspaces.ts";
import { isBusy } from "./app-store.ts";

const draft = { summary: "Auth redesign", description: "Body" };
const created = { key: "DEV-31", url: "https://example.com/DEV-31", epicLinked: false };

function baseComposer(overrides: Partial<ComposerValues> = {}): ComposerValues {
  return {
    ...initialComposerValues,
    sourceContent: { ...initialComposerValues.sourceContent },
    ...overrides,
  };
}

function openTwo(): TicketWorkspacesState {
  let state = ticketWorkspacesReducer(initialTicketWorkspacesState, {
    type: "project-loaded",
    defaultComposer: baseComposer(),
  });
  const secondId = nextTicketId();
  state = ticketWorkspacesReducer(state, {
    type: "ticket-opened",
    id: secondId,
    composer: baseComposer({
      sourceContent: { figma: "", log: "", prompt: "Second ticket prompt" },
    }),
  });
  return state;
}

beforeEach(() => {
  resetTicketIdCounter();
});

describe("ticketWorkspacesReducer", () => {
  test("project-loaded opens one active ticket workspace", () => {
    const state = ticketWorkspacesReducer(initialTicketWorkspacesState, {
      type: "project-loaded",
      defaultComposer: baseComposer({ projectKey: "DEV" }),
    });
    expect(state.tickets).toHaveLength(1);
    expect(state.activeTicketId).toBe(state.tickets[0]!.id);
    expect(state.tickets[0]!.composer.projectKey).toBe("DEV");
    expect(state.tickets[0]!.output.phase).toBe("idle");
  });

  test("ticket-opened adds a workspace and focuses it", () => {
    let state = ticketWorkspacesReducer(initialTicketWorkspacesState, {
      type: "project-loaded",
      defaultComposer: baseComposer(),
    });
    const firstId = state.activeTicketId!;
    const secondId = nextTicketId();
    state = ticketWorkspacesReducer(state, {
      type: "ticket-opened",
      id: secondId,
      composer: baseComposer({ issueType: "Bug" }),
    });
    expect(state.tickets).toHaveLength(2);
    expect(state.activeTicketId).toBe(secondId);
    expect(state.tickets.find((t) => t.id === firstId)).toBeDefined();
    expect(getActiveTicket(state)?.composer.issueType).toBe("Bug");
  });

  test("ticket-activated switches without mutating other workspaces", () => {
    let state = openTwo();
    const [first, second] = state.tickets;
    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: second!.id,
      action: { type: "generate-started", requestId: "r-b" },
    });
    state = ticketWorkspacesReducer(state, {
      type: "composer-patched",
      id: first!.id,
      patch: { extraInstructions: "focus a11y" },
    });
    state = ticketWorkspacesReducer(state, { type: "ticket-activated", id: first!.id });

    expect(state.activeTicketId).toBe(first!.id);
    expect(getActiveTicket(state)?.composer.extraInstructions).toBe("focus a11y");
    const background = state.tickets.find((t) => t.id === second!.id)!;
    expect(background.output.phase).toBe("generating");
    expect(background.output.activeRequestId).toBe("r-b");
    expect(isBusy(background.output.phase)).toBe(true);
  });

  test("each ticket keeps independent composer and output state", () => {
    let state = openTwo();
    const a = state.tickets[0]!.id;
    const b = state.tickets[1]!.id;

    state = ticketWorkspacesReducer(state, {
      type: "composer-patched",
      id: a,
      patch: {
        sourceContent: { figma: "", log: "", prompt: "Ticket A only" },
      },
    });
    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: a,
      action: { type: "generate-started", requestId: "r-a" },
    });
    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: a,
      action: { type: "generate-succeeded", draft },
    });
    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: b,
      action: { type: "generate-started", requestId: "r-b" },
    });

    const ticketA = state.tickets.find((t) => t.id === a)!;
    const ticketB = state.tickets.find((t) => t.id === b)!;
    expect(ticketA.composer.sourceContent.prompt).toBe("Ticket A only");
    expect(ticketA.output.phase).toBe("preview");
    expect(ticketA.output.draft).toEqual(draft);
    expect(ticketB.output.phase).toBe("generating");
    expect(ticketB.output.draft).toBeNull();
    expect(ticketB.composer.sourceContent.prompt).toBe("Second ticket prompt");
  });

  test("agent-chunk routes to the ticket that owns the requestId, not the active one", () => {
    let state = openTwo();
    const a = state.tickets[0]!.id;
    const b = state.tickets[1]!.id;

    // Start generate on A, then switch to B and start generate on B.
    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: a,
      action: { type: "generate-started", requestId: "req-a" },
    });
    state = ticketWorkspacesReducer(state, { type: "ticket-activated", id: b });
    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: b,
      action: { type: "generate-started", requestId: "req-b" },
    });

    state = ticketWorkspacesReducer(state, {
      type: "agent-chunk",
      requestId: "req-a",
      chunk: "from-a",
    });
    state = ticketWorkspacesReducer(state, {
      type: "agent-chunk",
      requestId: "req-b",
      chunk: "from-b",
    });
    state = ticketWorkspacesReducer(state, {
      type: "agent-chunk",
      requestId: "orphan",
      chunk: "ignored",
    });

    expect(state.tickets.find((t) => t.id === a)!.output.agentLog).toBe("from-a");
    expect(state.tickets.find((t) => t.id === b)!.output.agentLog).toBe("from-b");
    expect(state.activeTicketId).toBe(b);
  });

  test("completion on a background ticket does not contaminate the active ticket", () => {
    let state = openTwo();
    const a = state.tickets[0]!.id;
    const b = state.tickets[1]!.id;

    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: a,
      action: { type: "generate-started", requestId: "req-a" },
    });
    state = ticketWorkspacesReducer(state, { type: "ticket-activated", id: b });
    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: a,
      action: { type: "generate-succeeded", draft },
    });

    expect(state.activeTicketId).toBe(b);
    expect(getActiveTicket(state)?.output.phase).toBe("idle");
    expect(state.tickets.find((t) => t.id === a)!.output.phase).toBe("preview");
    expect(state.tickets.find((t) => t.id === a)!.output.draft).toEqual(draft);
  });

  test("failed agent run stays on that ticket; switching back resumes error state", () => {
    let state = openTwo();
    const a = state.tickets[0]!.id;
    const b = state.tickets[1]!.id;
    const error = { code: "agent-failed", message: "boom" };

    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: a,
      action: { type: "generate-started", requestId: "req-a" },
    });
    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: a,
      action: { type: "request-failed", error },
    });
    state = ticketWorkspacesReducer(state, { type: "ticket-activated", id: b });
    state = ticketWorkspacesReducer(state, { type: "ticket-activated", id: a });

    expect(getActiveTicket(state)?.output.phase).toBe("error");
    expect(getActiveTicket(state)?.output.error).toEqual(error);
  });

  test("closing a ticket leaves remaining tickets intact", () => {
    let state = openTwo();
    const a = state.tickets[0]!.id;
    const b = state.tickets[1]!.id;
    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: a,
      action: { type: "generate-started", requestId: "x" },
    });
    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: a,
      action: { type: "generate-succeeded", draft },
    });

    state = ticketWorkspacesReducer(state, { type: "ticket-closed", id: b });
    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0]!.id).toBe(a);
    expect(state.tickets[0]!.output.draft).toEqual(draft);
    expect(state.activeTicketId).toBe(a);
  });

  test("closing the last ticket yields an empty session", () => {
    let state = ticketWorkspacesReducer(initialTicketWorkspacesState, {
      type: "project-loaded",
      defaultComposer: baseComposer(),
    });
    const id = state.activeTicketId!;
    state = ticketWorkspacesReducer(state, { type: "ticket-closed", id });
    expect(state.tickets).toHaveLength(0);
    expect(state.activeTicketId).toBeNull();
    expect(getActiveTicket(state)).toBeNull();
  });

  test("returning to a previously opened ticket restores composer and output", () => {
    let state = openTwo();
    const a = state.tickets[0]!.id;
    const b = state.tickets[1]!.id;

    state = ticketWorkspacesReducer(state, {
      type: "composer-patched",
      id: a,
      patch: { epicKey: "EPIC-1", extraInstructions: "keep this" },
    });
    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: a,
      action: { type: "generate-started", requestId: "r1" },
    });
    state = ticketWorkspacesReducer(state, {
      type: "output-action",
      id: a,
      action: { type: "generate-succeeded", draft },
    });
    state = ticketWorkspacesReducer(state, { type: "ticket-activated", id: b });
    state = ticketWorkspacesReducer(state, {
      type: "composer-patched",
      id: b,
      patch: { epicKey: "OTHER" },
    });
    state = ticketWorkspacesReducer(state, { type: "ticket-activated", id: a });

    const resumed = getActiveTicket(state)!;
    expect(resumed.id).toBe(a);
    expect(resumed.composer.epicKey).toBe("EPIC-1");
    expect(resumed.composer.extraInstructions).toBe("keep this");
    expect(resumed.output.phase).toBe("preview");
    expect(resumed.output.draft).toEqual(draft);
  });

  test("project-loaded resets prior workspaces for a new session", () => {
    let state = openTwo();
    state = ticketWorkspacesReducer(state, {
      type: "project-loaded",
      defaultComposer: baseComposer({ projectKey: "NEW" }),
    });
    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0]!.composer.projectKey).toBe("NEW");
    expect(state.tickets[0]!.output.phase).toBe("idle");
  });
});

describe("pickActiveAfterClose", () => {
  test("prefers the ticket above when closing the active ticket", () => {
    const tickets = [
      createTicketWorkspace("t1"),
      createTicketWorkspace("t2"),
      createTicketWorkspace("t3"),
    ];
    expect(pickActiveAfterClose(tickets, "t2", "t2")).toBe("t1");
    expect(pickActiveAfterClose(tickets, "t1", "t1")).toBe("t2");
    expect(pickActiveAfterClose(tickets, "t3", "t3")).toBe("t2");
  });

  test("keeps active when closing a different ticket", () => {
    const tickets = [createTicketWorkspace("t1"), createTicketWorkspace("t2")];
    expect(pickActiveAfterClose(tickets, "t1", "t2")).toBe("t2");
  });
});

describe("ticketTitle and ticketAgentStatus", () => {
  test("title prefers created key, then draft summary, then source preview", () => {
    let ticket = createTicketWorkspace("t1", baseComposer());
    expect(ticketTitle(ticket)).toBe("New ticket");

    ticket = {
      ...ticket,
      composer: baseComposer({
        sourceContent: { figma: "", log: "", prompt: "Build the sidebar\nmore lines" },
      }),
    };
    expect(ticketTitle(ticket)).toBe("Build the sidebar");

    ticket = {
      ...ticket,
      output: {
        ...ticket.output,
        draft,
        phase: "preview",
      },
    };
    expect(ticketTitle(ticket)).toBe("Auth redesign");

    ticket = {
      ...ticket,
      output: {
        ...ticket.output,
        created,
        phase: "done",
      },
    };
    expect(ticketTitle(ticket)).toBe("DEV-31");
  });

  test("agent status maps phases for sidebar badges", () => {
    expect(ticketAgentStatus("generating")).toBe("running");
    expect(ticketAgentStatus("editing")).toBe("running");
    expect(ticketAgentStatus("decomposing")).toBe("running");
    expect(ticketAgentStatus("creating")).toBe("running");
    expect(ticketAgentStatus("preview")).toBe("ready");
    expect(ticketAgentStatus("subtask-review")).toBe("ready");
    expect(ticketAgentStatus("error")).toBe("error");
    expect(ticketAgentStatus("done")).toBe("done");
    expect(ticketAgentStatus("idle")).toBe("idle");
  });
});
