/**
 * Chat bot orchestration: routes thread events through the session state
 * machine and the PM engine, posting progress and results back to the thread.
 *
 * Transport-agnostic: depends only on {@link BotThread} and the engine, so
 * the same logic serves Slack, Telegram, and test fakes.
 */

import type { PmEngine } from "../engine/index.js";
import {
  renderAlreadyCreated,
  renderBusy,
  renderCreated,
  renderDraft,
  renderError,
  renderHelp,
  renderProgress,
  CREATE_ACTION_ID,
  DECOMPOSE_ACTION_ID,
} from "./messages.js";
import { classifyReply, createSession } from "./session.js";
import type { DraftSession } from "./session.js";
import type { SessionStore } from "./store.js";
import type { BotThread, DraftMessageHandle } from "./types.js";

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Minimum interval between progress-message edits while the agent streams. */
const PROGRESS_EDIT_INTERVAL_MS = 5000;

const CHAT_EXTRA_INSTRUCTIONS =
  "The request came from a chat message; it may be terse. Infer reasonable scope without inventing major features.";

export interface ChatBotOptions {
  engine: PmEngine;
  store: SessionStore;
  /** Bot display name used in help text. */
  botName?: string;
  sessionTtlMs?: number;
  log?: (line: string) => void;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface ChatBot {
  /**
   * Handle a user message. `isNewConversation` is true when the message can
   * start a session (mention, DM, slash command); plain replies in threads
   * without a session are ignored.
   */
  handleMessage(thread: BotThread, text: string, isNewConversation: boolean): Promise<void>;
  /** Approve signal from a reaction; approves the thread's drafted session. */
  handleApprove(thread: BotThread): Promise<void>;
  /** Button press on a bot message. */
  handleAction(thread: BotThread, actionId: string): Promise<void>;
  /** True when this thread has an active session (used to filter noise). */
  hasSession(threadKey: string): boolean;
  /** Remove idle sessions past their TTL. */
  sweepExpiredSessions(): Promise<void>;
  /** Wait for in-flight engine work to finish (shutdown drain). */
  drain(): Promise<void>;
}

export function createChatBot(options: ChatBotOptions): ChatBot {
  const { engine, store } = options;
  const botName = options.botName ?? "devpm";
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;

  /** Per-thread in-flight work; also drives the busy/pending-text behavior. */
  const inflight = new Map<string, Promise<void>>();
  /** Latest message that arrived while its thread was busy (latest wins). */
  const pendingText = new Map<string, string>();
  /** Draft message handles for in-place edits; lost on restart by design. */
  const draftHandles = new Map<string, DraftMessageHandle>();
  /** Serialize engine calls globally: one agent subprocess at a time. */
  let engineQueue: Promise<unknown> = Promise.resolve();

  function queueEngineCall<T>(work: () => Promise<T>): Promise<T> {
    const result = engineQueue.then(work, work);
    engineQueue = result.catch(() => {});
    return result;
  }

  async function touch(session: DraftSession): Promise<void> {
    session.updatedAt = now();
    await store.upsert(session);
  }

  /**
   * Post a progress message and keep it minimally alive while the agent
   * streams (agent runs can take minutes; edits are throttled).
   */
  async function withProgress<T>(
    thread: BotThread,
    step: Parameters<typeof renderProgress>[0],
    work: (events: {
      onAgentChunk: (chunk: string, stream: "stdout" | "stderr") => void;
    }) => Promise<T>,
  ): Promise<{ result: T; handle: DraftMessageHandle }> {
    await thread.startTyping().catch(() => {});
    const handle = await thread.post(renderProgress(step));
    const startedAt = now();
    let lastEdit = startedAt;
    let editChain: Promise<void> = Promise.resolve();

    const onAgentChunk = (): void => {
      const at = now();
      if (at - lastEdit < PROGRESS_EDIT_INTERVAL_MS) return;
      lastEdit = at;
      const elapsed = Math.round((at - startedAt) / 1000);
      editChain = editChain
        .then(() => handle.edit({ text: `${renderProgress(step).text} (${elapsed}s)` }))
        .catch(() => {});
    };

    const result = await work({ onAgentChunk });
    await editChain.catch(() => {});
    return { result, handle };
  }

  /** Show the current draft, editing the progress/draft message in place. */
  async function presentDraft(
    thread: BotThread,
    session: DraftSession,
    handle: DraftMessageHandle,
  ): Promise<void> {
    await handle.edit(renderDraft(session));
    draftHandles.set(session.key, handle);
  }

  async function failSession(
    thread: BotThread,
    session: DraftSession,
    error: unknown,
  ): Promise<void> {
    session.status = session.draft ? "drafted" : "failed";
    await touch(session);
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    log(`session=${session.key} engine error: ${detail}`);
    await thread.post(renderError(error)).catch(() => {});
  }

  async function startSession(thread: BotThread, text: string): Promise<void> {
    const session = createSession(thread.key, thread.platform, text, now());
    await store.upsert(session);
    await thread.subscribe().catch(() => {});
    log(`session=${session.key} generating from: ${text.slice(0, 80)}`);

    try {
      const { result: draft, handle } = await withProgress(thread, "generating", (events) =>
        queueEngineCall(() =>
          engine.generateStory(
            {
              source: session.source,
              promptStyle: "pm",
              extraInstructions: CHAT_EXTRA_INSTRUCTIONS,
            },
            events,
          ),
        ),
      );
      session.draft = draft;
      session.status = "drafted";
      await touch(session);
      await presentDraft(thread, session, handle);
    } catch (error) {
      await failSession(thread, session, error);
    }
  }

  async function editDraft(
    thread: BotThread,
    session: DraftSession,
    editPrompt: string,
  ): Promise<void> {
    if (!session.draft) {
      // Failed before a draft existed: treat the reply as a fresh idea.
      await startSession(thread, editPrompt);
      return;
    }
    session.status = "generating";
    session.history.push(editPrompt);
    await touch(session);

    try {
      const { result: draft, handle } = await withProgress(thread, "editing", (events) =>
        queueEngineCall(() =>
          engine.editStory(
            { current: session.draft!, editPrompt, issueType: session.issueType },
            events,
          ),
        ),
      );
      session.draft = draft;
      session.status = "drafted";
      await touch(session);
      await presentDraft(thread, session, handle);
    } catch (error) {
      await failSession(thread, session, error);
    }
  }

  async function decompose(thread: BotThread, session: DraftSession): Promise<void> {
    if (!session.draft) return;
    session.status = "generating";
    await touch(session);

    try {
      const { result: subtasks, handle } = await withProgress(thread, "decomposing", (events) =>
        queueEngineCall(() =>
          engine.decomposeStory(
            { story: session.draft!, sourceType: "prompt", promptStyle: "pm" },
            events,
          ),
        ),
      );
      session.subtasks = subtasks;
      session.status = "drafted";
      await touch(session);
      await presentDraft(thread, session, handle);
    } catch (error) {
      await failSession(thread, session, error);
    }
  }

  async function updateSettings(
    thread: BotThread,
    session: DraftSession,
    update: Partial<Pick<DraftSession, "issueType" | "projectKey">>,
  ): Promise<void> {
    Object.assign(session, update);
    await touch(session);
    const handle = draftHandles.get(session.key);
    if (handle) {
      await handle.edit(renderDraft(session)).catch(() => {});
    } else {
      draftHandles.set(session.key, await thread.post(renderDraft(session)));
    }
  }

  async function approve(thread: BotThread, session: DraftSession): Promise<void> {
    if (session.status !== "drafted" || !session.draft) return;
    session.status = "creating";
    await touch(session);
    log(`session=${session.key} creating task via ${engine.backendName}`);

    try {
      const draft = session.draft;
      const result = await engine.createTask(draft, {
        issueType: session.issueType,
        projectKey: session.projectKey ?? engine.defaultProjectKey,
      });

      const subtaskKeys: string[] = [];
      const subtaskErrors: string[] = [];
      for (const subtask of session.subtasks ?? []) {
        try {
          const created = await engine.createSubtask(
            result.task.key,
            subtask,
            session.projectKey ?? engine.defaultProjectKey,
          );
          subtaskKeys.push(created.key);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          subtaskErrors.push(`Subtask "${subtask.summary}" failed: ${message}`);
        }
      }

      session.status = "done";
      session.createdTaskKey = result.task.key;
      session.createdTaskUrl = result.task.url;
      await touch(session);
      draftHandles.delete(session.key);
      await thread.post(renderCreated(result, subtaskKeys, subtaskErrors));
      log(`session=${session.key} created ${result.task.key}`);
    } catch (error) {
      await failSession(thread, session, error);
    }
  }

  async function routeDraftedReply(
    thread: BotThread,
    session: DraftSession,
    text: string,
  ): Promise<void> {
    const intent = classifyReply(text);
    switch (intent.kind) {
      case "approve":
        await approve(thread, session);
        return;
      case "decompose":
        await decompose(thread, session);
        return;
      case "set-type":
        await updateSettings(thread, session, { issueType: intent.issueType });
        return;
      case "set-project":
        await updateSettings(thread, session, { projectKey: intent.projectKey });
        return;
      case "help":
        await thread.post(renderHelp(botName));
        return;
      case "edit":
        await editDraft(thread, session, intent.prompt);
        return;
    }
  }

  /**
   * Run `work` as the thread's in-flight task; when it settles, apply the
   * latest message that arrived while busy (if any).
   */
  function runExclusive(thread: BotThread, work: () => Promise<void>): Promise<void> {
    const task = work().finally(async () => {
      inflight.delete(thread.key);
      const queued = pendingText.get(thread.key);
      if (queued !== undefined) {
        pendingText.delete(thread.key);
        await dispatchMessage(thread, queued, false);
      }
    });
    inflight.set(thread.key, task);
    return task;
  }

  async function dispatchMessage(
    thread: BotThread,
    text: string,
    isNewConversation: boolean,
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (inflight.has(thread.key)) {
      pendingText.set(thread.key, trimmed);
      await thread.post(renderBusy()).catch(() => {});
      return;
    }

    const session = store.get(thread.key);
    if (!session) {
      if (isNewConversation) {
        await runExclusive(thread, () => startSession(thread, trimmed));
      }
      return;
    }

    switch (session.status) {
      case "done":
        if (isNewConversation) {
          // A fresh mention in a finished thread starts a new draft.
          await store.delete(session.key);
          await runExclusive(thread, () => startSession(thread, trimmed));
        } else {
          await thread.post(renderAlreadyCreated(session)).catch(() => {});
        }
        return;
      case "failed":
        await runExclusive(thread, () => editDraft(thread, session, trimmed));
        return;
      case "drafted":
        await runExclusive(thread, () => routeDraftedReply(thread, session, trimmed));
        return;
      case "generating":
      case "creating":
        // No in-flight entry (e.g. restart mid-run rewrote nothing yet):
        // recover by treating the message as an edit.
        session.status = session.draft ? "drafted" : "failed";
        await touch(session);
        await runExclusive(thread, () => routeDraftedReply(thread, session, trimmed));
        return;
    }
  }

  return {
    handleMessage: dispatchMessage,

    async handleApprove(thread) {
      if (inflight.has(thread.key)) return;
      const session = store.get(thread.key);
      if (!session || session.status !== "drafted") return;
      await runExclusive(thread, () => approve(thread, session));
    },

    async handleAction(thread, actionId) {
      if (inflight.has(thread.key)) return;
      const session = store.get(thread.key);
      if (!session || session.status !== "drafted") return;
      if (actionId === CREATE_ACTION_ID) {
        await runExclusive(thread, () => approve(thread, session));
      } else if (actionId === DECOMPOSE_ACTION_ID) {
        await runExclusive(thread, () => decompose(thread, session));
      }
    },

    hasSession(threadKey) {
      return store.get(threadKey) !== undefined;
    },

    async sweepExpiredSessions() {
      const removed = await store.sweepExpired(now(), sessionTtlMs);
      for (const session of removed) {
        draftHandles.delete(session.key);
        pendingText.delete(session.key);
        log(`session=${session.key} expired`);
      }
    },

    async drain() {
      await Promise.allSettled(inflight.values());
    },
  };
}
