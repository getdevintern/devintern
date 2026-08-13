/**
 * Message rendering for the chat bot.
 *
 * Produces generic markdown; the transport (Chat SDK) converts it to each
 * platform's native format (Block Kit, MarkdownV2, ...).
 */

import { EngineError } from "../engine/index.js";
import type { CreateTaskResult } from "../engine/index.js";
import type { DraftSession } from "./session.js";
import type { OutgoingMessage } from "./types.js";

/** Keep drafts within the tightest platform message limit (Telegram: 4096). */
const MAX_DRAFT_CHARS = 3500;

export const CREATE_ACTION_ID = "devpm-create";
export const DECOMPOSE_ACTION_ID = "devpm-decompose";

/** Render the current draft with refinement hints and action buttons. */
export function renderDraft(session: DraftSession): OutgoingMessage {
  const draft = session.draft;
  if (!draft) {
    return { text: "_No draft yet. Send me a rough idea to get started._" };
  }

  let description = draft.description;
  if (description.length > MAX_DRAFT_CHARS) {
    description = `${description.slice(0, MAX_DRAFT_CHARS)}\n\n_…truncated for chat; the full description is used when the task is created._`;
  }

  const lines = [`**${draft.summary}**`, "", description, ""];

  if (session.subtasks && session.subtasks.length > 0) {
    lines.push("**Subtasks:**");
    for (const subtask of session.subtasks) {
      lines.push(`- ${subtask.summary}`);
    }
    lines.push("");
  }

  const settings = [`Type: ${session.issueType}`];
  if (session.projectKey) settings.push(`Project: ${session.projectKey}`);
  lines.push(`_${settings.join(" · ")} — reply to refine, react ✅ or press Create to file it._`);

  return {
    text: lines.join("\n"),
    buttons: [
      { actionId: CREATE_ACTION_ID, label: "Create" },
      { actionId: DECOMPOSE_ACTION_ID, label: "Split into subtasks" },
    ],
  };
}

/** Progress placeholder posted while an engine call runs. */
export function renderProgress(
  step: "generating" | "editing" | "decomposing" | "creating",
): OutgoingMessage {
  const text = {
    generating: "✍️ Drafting your story…",
    editing: "✍️ Reworking the draft…",
    decomposing: "✂️ Splitting into subtasks…",
    creating: "🚀 Creating the task…",
  }[step];
  return { text };
}

/** Success message with the created task link(s). */
export function renderCreated(
  result: CreateTaskResult,
  subtaskKeys: string[],
  subtaskErrors: string[],
): OutgoingMessage {
  const lines = [`✅ Created [${result.task.key}](${result.task.url})`];
  if (subtaskKeys.length > 0) {
    lines.push(`Subtasks: ${subtaskKeys.join(", ")}`);
  }
  if (result.epicLinkError) {
    lines.push(`⚠️ Task created, but epic linking failed: ${result.epicLinkError}`);
  }
  for (const error of subtaskErrors) {
    lines.push(`⚠️ ${error}`);
  }
  return { text: lines.join("\n") };
}

/**
 * User-facing error text. Raw diagnostics (`EngineError.detail`) stay in the
 * daemon log; chat only gets an actionable summary.
 */
export function renderError(error: unknown): OutgoingMessage {
  if (error instanceof EngineError) {
    const text = {
      "agent-failed":
        "⚠️ The AI agent failed to run on the host machine. Check the `devpm serve` logs, then send your request again.",
      "parse-failed":
        "⚠️ The AI agent returned something I couldn't parse into a draft. Try rephrasing your request.",
      "backend-failed": `⚠️ The task tracker rejected the request: ${error.message}`,
    }[error.code];
    return { text };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { text: `⚠️ Something went wrong: ${message}` };
}

/** Reply for messages that arrive while an engine call is already running. */
export function renderBusy(): OutgoingMessage {
  return {
    text: "⏳ Still working on the previous request — I'll apply your latest message when it finishes.",
  };
}

/** Reply for threads whose task was already created. */
export function renderAlreadyCreated(session: DraftSession): OutgoingMessage {
  const link = session.createdTaskUrl
    ? `[${session.createdTaskKey ?? "task"}](${session.createdTaskUrl})`
    : "a task";
  return {
    text: `This thread already produced ${link}. Mention me in a new message to start another draft.`,
  };
}

/** Short usage help. */
export function renderHelp(botName: string): OutgoingMessage {
  return {
    text: [
      `Mention me with a rough idea and I'll draft a task, e.g. \`@${botName} users should be able to reset their password\`.`,
      "",
      "In a draft thread you can:",
      "- reply with edits in plain language",
      "- `type <IssueType>` / `project <KEY>` to change settings",
      "- `split` to break the story into subtasks",
      "- `create` (or react ✅) to file the task",
    ].join("\n"),
  };
}
