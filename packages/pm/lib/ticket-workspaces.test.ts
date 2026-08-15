import { describe, expect, test, beforeEach } from "bun:test";
import {
  createInitialWizard,
  createTicketWorkspace,
  getActiveTicket,
  isTicketBusy,
  nextTicketId,
  pickActiveAfterClose,
  resetTicketIdCounter,
  ticketAgentStatus,
  ticketTitle,
  ticketWorkspacesReducer,
  initialTicketWorkspacesState,
} from "./ticket-workspaces.ts";
import type { TicketWorkspacesState, TicketWizardState } from "./ticket-workspaces.ts";

function baseWizard(overrides: Partial<TicketWizardState> = {}): TicketWizardState {
  return {
    ...createInitialWizard({ issueType: "Task", projectKey: "DEV" }),
    ...overrides,
  };
}

function openTwo(): TicketWorkspacesState {
  let state = ticketWorkspacesReducer(initialTicketWorkspacesState, {
    type: "session-started",
    id: nextTicketId(),
    wizard: baseWizard(),
  });
  state = ticketWorkspacesReducer(state, {
    type: "ticket-opened",
    id: nextTicketId(),
    wizard: baseWizard({
      sourceType: "prompt",
      sourceContent: "Second ticket prompt",
    }),
  });
  return state;
}

beforeEach(() => {
  resetTicketIdCounter();
});

describe("ticketWorkspacesReducer", () => {
  test("session-started opens one active ticket workspace", () => {
    const state = ticketWorkspacesReducer(initialTicketWorkspacesState, {
      type: "session-started",
      id: nextTicketId(),
      wizard: baseWizard({ projectKey: "DEV" }),
    });
    expect(state.tickets).toHaveLength(1);
    expect(state.activeTicketId).toBe(state.tickets[0]!.id);
    expect(state.tickets[0]!.wizard.projectKey).toBe("DEV");
    expect(state.tickets[0]!.wizard.step).toBe("source-type");
  });

  test("ticket-opened adds a workspace and focuses it", () => {
    let state = ticketWorkspacesReducer(initialTicketWorkspacesState, {
      type: "session-started",
      id: nextTicketId(),
      wizard: baseWizard(),
    });
    const firstId = state.activeTicketId!;
    const secondId = nextTicketId();
    state = ticketWorkspacesReducer(state, {
      type: "ticket-opened",
      id: secondId,
      wizard: baseWizard({ issueType: "Bug" }),
    });
    expect(state.tickets).toHaveLength(2);
    expect(state.activeTicketId).toBe(secondId);
    expect(state.tickets.find((t) => t.id === firstId)).toBeDefined();
    expect(getActiveTicket(state)?.wizard.issueType).toBe("Bug");
  });

  test("ticket-activated switches without mutating other workspaces", () => {
    let state = openTwo();
    const [first, second] = state.tickets;
    state = ticketWorkspacesReducer(state, {
      type: "wizard-patched",
      id: second!.id,
      patch: { step: "generating", statusMessage: "Running…" },
    });
    state = ticketWorkspacesReducer(state, {
      type: "wizard-patched",
      id: first!.id,
      patch: { customInstructions: "focus a11y", draftInput: "partial" },
    });
    state = ticketWorkspacesReducer(state, { type: "ticket-activated", id: first!.id });

    expect(state.activeTicketId).toBe(first!.id);
    expect(getActiveTicket(state)?.wizard.customInstructions).toBe("focus a11y");
    expect(getActiveTicket(state)?.wizard.draftInput).toBe("partial");
    const background = state.tickets.find((t) => t.id === second!.id)!;
    expect(background.wizard.step).toBe("generating");
    expect(isTicketBusy(background.wizard.step)).toBe(true);
  });

  test("each ticket keeps independent wizard state", () => {
    let state = openTwo();
    const a = state.tickets[0]!.id;
    const b = state.tickets[1]!.id;

    state = ticketWorkspacesReducer(state, {
      type: "wizard-patched",
      id: a,
      patch: {
        sourceContent: "Ticket A only",
        step: "preview",
        previewData: { summary: "Auth redesign", description: "Body" },
      },
    });
    state = ticketWorkspacesReducer(state, {
      type: "wizard-patched",
      id: b,
      patch: { step: "generating" },
    });

    const ticketA = state.tickets.find((t) => t.id === a)!;
    const ticketB = state.tickets.find((t) => t.id === b)!;
    expect(ticketA.wizard.sourceContent).toBe("Ticket A only");
    expect(ticketA.wizard.step).toBe("preview");
    expect(ticketA.wizard.previewData?.summary).toBe("Auth redesign");
    expect(ticketB.wizard.step).toBe("generating");
    expect(ticketB.wizard.previewData).toBeUndefined();
    expect(ticketB.wizard.sourceContent).toBe("Second ticket prompt");
  });

  test("background ticket completion does not contaminate the active ticket", () => {
    let state = openTwo();
    const a = state.tickets[0]!.id;
    const b = state.tickets[1]!.id;

    state = ticketWorkspacesReducer(state, {
      type: "wizard-patched",
      id: a,
      patch: { step: "generating" },
    });
    state = ticketWorkspacesReducer(state, { type: "ticket-activated", id: b });
    state = ticketWorkspacesReducer(state, {
      type: "wizard-patched",
      id: a,
      patch: {
        step: "preview",
        previewData: { summary: "Done A", description: "Body A" },
      },
    });

    expect(state.activeTicketId).toBe(b);
    expect(getActiveTicket(state)?.wizard.step).toBe("source-type");
    expect(state.tickets.find((t) => t.id === a)!.wizard.step).toBe("preview");
    expect(state.tickets.find((t) => t.id === a)!.wizard.previewData?.summary).toBe("Done A");
  });

  test("closing a ticket leaves remaining tickets intact", () => {
    let state = openTwo();
    const a = state.tickets[0]!.id;
    const b = state.tickets[1]!.id;
    state = ticketWorkspacesReducer(state, {
      type: "wizard-patched",
      id: a,
      patch: {
        step: "preview",
        previewData: { summary: "Keep me", description: "Body" },
      },
    });

    state = ticketWorkspacesReducer(state, { type: "ticket-closed", id: b });
    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0]!.id).toBe(a);
    expect(state.tickets[0]!.wizard.previewData?.summary).toBe("Keep me");
    expect(state.activeTicketId).toBe(a);
  });

  test("closing the last ticket yields an empty session", () => {
    let state = ticketWorkspacesReducer(initialTicketWorkspacesState, {
      type: "session-started",
      id: nextTicketId(),
      wizard: baseWizard(),
    });
    const id = state.activeTicketId!;
    state = ticketWorkspacesReducer(state, { type: "ticket-closed", id });
    expect(state.tickets).toHaveLength(0);
    expect(state.activeTicketId).toBeNull();
    expect(getActiveTicket(state)).toBeNull();
  });

  test("returning to a previously opened ticket restores wizard fields", () => {
    let state = openTwo();
    const a = state.tickets[0]!.id;
    const b = state.tickets[1]!.id;

    state = ticketWorkspacesReducer(state, {
      type: "wizard-patched",
      id: a,
      patch: {
        epicKey: "EPIC-1",
        customInstructions: "keep this",
        step: "preview",
        previewData: { summary: "Auth redesign", description: "Body" },
        draftInput: "half typed",
      },
    });
    state = ticketWorkspacesReducer(state, { type: "ticket-activated", id: b });
    state = ticketWorkspacesReducer(state, {
      type: "wizard-patched",
      id: b,
      patch: { epicKey: "OTHER" },
    });
    state = ticketWorkspacesReducer(state, { type: "ticket-activated", id: a });

    const resumed = getActiveTicket(state)!;
    expect(resumed.id).toBe(a);
    expect(resumed.wizard.epicKey).toBe("EPIC-1");
    expect(resumed.wizard.customInstructions).toBe("keep this");
    expect(resumed.wizard.step).toBe("preview");
    expect(resumed.wizard.previewData?.summary).toBe("Auth redesign");
    expect(resumed.wizard.draftInput).toBe("half typed");
  });
});

describe("pickActiveAfterClose", () => {
  test("prefers the ticket above when closing the active ticket", () => {
    const tickets = [
      createTicketWorkspace("t1", baseWizard()),
      createTicketWorkspace("t2", baseWizard()),
      createTicketWorkspace("t3", baseWizard()),
    ];
    expect(pickActiveAfterClose(tickets, "t2", "t2")).toBe("t1");
    expect(pickActiveAfterClose(tickets, "t1", "t1")).toBe("t2");
    expect(pickActiveAfterClose(tickets, "t3", "t3")).toBe("t2");
  });

  test("keeps active when closing a different ticket", () => {
    const tickets = [
      createTicketWorkspace("t1", baseWizard()),
      createTicketWorkspace("t2", baseWizard()),
    ];
    expect(pickActiveAfterClose(tickets, "t1", "t2")).toBe("t2");
  });
});

describe("ticketTitle and ticketAgentStatus", () => {
  test("title prefers created key, then draft summary, then source preview", () => {
    let ticket = createTicketWorkspace("t1", baseWizard());
    expect(ticketTitle(ticket)).toBe("New ticket");

    ticket = {
      ...ticket,
      wizard: baseWizard({
        sourceContent: "Build the sidebar\nmore lines",
      }),
    };
    expect(ticketTitle(ticket)).toBe("Build the sidebar");

    ticket = {
      ...ticket,
      wizard: {
        ...ticket.wizard,
        previewData: { summary: "Auth redesign", description: "Body" },
        step: "preview",
      },
    };
    expect(ticketTitle(ticket)).toBe("Auth redesign");

    ticket = {
      ...ticket,
      wizard: {
        ...ticket.wizard,
        createdKey: "DEV-31",
        step: "success",
      },
    };
    expect(ticketTitle(ticket)).toBe("DEV-31");
  });

  test("agent status maps steps for sidebar badges", () => {
    expect(ticketAgentStatus("generating")).toBe("running");
    expect(ticketAgentStatus("regenerating")).toBe("running");
    expect(ticketAgentStatus("done")).toBe("running");
    expect(ticketAgentStatus("preview")).toBe("ready");
    expect(ticketAgentStatus("edit-prompt")).toBe("ready");
    expect(ticketAgentStatus("confirm")).toBe("ready");
    expect(ticketAgentStatus("success")).toBe("done");
    expect(ticketAgentStatus("success", true)).toBe("error");
    expect(ticketAgentStatus("source-type")).toBe("idle");
    expect(ticketAgentStatus("project")).toBe("idle");
  });
});
