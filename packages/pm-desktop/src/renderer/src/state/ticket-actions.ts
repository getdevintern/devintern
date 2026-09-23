/**
 * Ticket agent actions, extracted from `App.tsx` so they stay unit-testable
 * without rendering. Each action reads the latest store snapshot via
 * `getState()` and routes results back through `applyOutputAction`.
 */

import { defaultComposerForProject } from "./composer-values.ts";
import { useProjectStore } from "./project-store.ts";
import { isTicketActionBlocked } from "./selectors.ts";
import { getActiveTicketFromStore, useTicketWorkspacesStore } from "./ticket-workspaces-store.ts";
import { nextTicketId } from "./ticket-workspaces.ts";
import { toError } from "./ipc-error.ts";

let requestCounter = 0;
const nextRequestId = () => `req-${++requestCounter}`;

/** Open a fresh ticket workspace for a fully ready project. */
export function openTicket(canOpenTicket: boolean, issueTypes: string[]): void {
  // Only fully ready projects (git + configured PM) should open ticket workspaces.
  const current = useProjectStore.getState().status;
  if (!canOpenTicket || !current) return;
  const composer = defaultComposerForProject(current, issueTypes);
  useTicketWorkspacesStore.getState().openTicket(nextTicketId(), composer);
}

export async function generate(): Promise<void> {
  const ticket = getActiveTicketFromStore();
  if (!ticket) return;
  const ticketId = ticket.id;
  const values = ticket.composer;
  const content = values.sourceContent[values.sourceType];
  // Per-ticket + chrome only — another ticket generating must not block this one.
  if (!content.trim() || isTicketActionBlocked(ticket)) return;
  const requestId = nextRequestId();
  useTicketWorkspacesStore.getState().applyOutputAction(ticketId, {
    type: "generate-started",
    requestId,
  });
  const result = await window.pm.generateStory(requestId, {
    source: { type: values.sourceType, content },
    promptStyle: values.promptStyle,
    epicKey: values.epicKey || undefined,
    extraInstructions: values.extraInstructions || undefined,
    attachments: values.attachments.length > 0 ? values.attachments : undefined,
  });
  // Always target ticketId — user may have switched away while generating.
  const store = useTicketWorkspacesStore.getState();
  if (result.ok) {
    store.applyOutputAction(ticketId, { type: "generate-succeeded", draft: result.value });
  } else {
    store.applyOutputAction(ticketId, { type: "request-failed", error: toError(result.error) });
  }
}

export async function edit(editPrompt: string): Promise<void> {
  const ticket = getActiveTicketFromStore();
  if (!ticket?.output.draft) return;
  // Same multi-ticket independence as Generate / Create Task.
  if (isTicketActionBlocked(ticket)) return;
  const ticketId = ticket.id;
  const draft = ticket.output.draft;
  const issueType = ticket.composer.issueType;
  const requestId = nextRequestId();
  const store = useTicketWorkspacesStore.getState();
  store.applyOutputAction(ticketId, { type: "edit-started", requestId });
  const result = await window.pm.editStory(requestId, {
    current: draft,
    editPrompt,
    issueType,
  });
  if (result.ok) {
    store.applyOutputAction(ticketId, { type: "edit-succeeded", draft: result.value });
  } else {
    store.applyOutputAction(ticketId, { type: "request-failed", error: toError(result.error) });
  }
}

export async function create(labelsError: string | null): Promise<void> {
  const ticket = getActiveTicketFromStore();
  if (!ticket?.output.draft) return;
  // Create Task on an idle ticket must not wait for an unrelated run.
  // isTicketActionBlocked also blocks double-clicks before create-started re-renders.
  if (isTicketActionBlocked(ticket)) return;
  const ticketId = ticket.id;
  const values = ticket.composer;
  const draft = ticket.output.draft;
  const currentStatus = useProjectStore.getState().status;
  // Hold a main-process agent request id across create + optional decompose so a
  // context switch cannot sneak into the gap between those IPCs (Set allows
  // concurrent holds from other tickets).
  const flowRequestId = `create-flow:${nextRequestId()}`;
  const store = useTicketWorkspacesStore.getState();
  store.applyOutputAction(ticketId, { type: "create-started" });
  const hold = await window.pm.beginAgentRequest(flowRequestId);
  if (!hold.ok) {
    store.applyOutputAction(ticketId, { type: "request-failed", error: toError(hold.error) });
    return;
  }
  try {
    const result = await window.pm.createTask({
      draft,
      issueType: values.issueType,
      projectKey: values.projectKey || undefined,
      epicKey: values.epicKey || undefined,
      // Omit labels while the picker failed — stale ids must not reach create.
      // Main ignores any prevalidation flag and re-checks against getLabels.
      labels:
        currentStatus?.supportsLabels &&
        values.labels.length > 0 &&
        (!labelsError || currentStatus.supportsFreeformLabels)
          ? values.labels
          : undefined,
      attachments: values.attachments.length > 0 ? values.attachments : undefined,
    });
    if (!result.ok) {
      store.applyOutputAction(ticketId, { type: "request-failed", error: toError(result.error) });
      return;
    }
    store.applyOutputAction(ticketId, { type: "create-succeeded", created: result.value });

    if (values.decompose) {
      const requestId = nextRequestId();
      store.applyOutputAction(ticketId, { type: "decompose-started", requestId });
      const decomposed = await window.pm.decomposeStory(requestId, {
        story: draft,
        sourceType: values.sourceType,
        promptStyle: values.promptStyle,
      });
      if (decomposed.ok) {
        store.applyOutputAction(ticketId, {
          type: "decompose-succeeded",
          subtasks: decomposed.value,
        });
      } else {
        store.applyOutputAction(ticketId, {
          type: "request-failed",
          error: toError(decomposed.error),
        });
      }
    }
  } finally {
    await window.pm.endAgentRequest(flowRequestId);
  }
}

export async function createSubtasks(): Promise<void> {
  const ticket = getActiveTicketFromStore();
  if (!ticket?.output.created) return;
  // Same multi-ticket independence as Generate / Create Task.
  if (isTicketActionBlocked(ticket)) return;
  const ticketId = ticket.id;
  const parentKey = ticket.output.created.key;
  const output = ticket.output;
  const projectKey = ticket.composer.projectKey || undefined;
  const selected = output.subtasks.filter((_, i) => output.selectedSubtasks.has(i));
  const store = useTicketWorkspacesStore.getState();
  store.applyOutputAction(ticketId, { type: "create-subtasks-started" });
  const result = await window.pm.createSubtasks(parentKey, selected, projectKey);
  if (result.ok) {
    store.applyOutputAction(ticketId, {
      type: "create-subtasks-finished",
      outcomes: result.value,
    });
  } else {
    store.applyOutputAction(ticketId, { type: "request-failed", error: toError(result.error) });
  }
}
