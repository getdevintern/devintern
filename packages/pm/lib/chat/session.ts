/**
 * Draft session model and pure helpers for the chat bot.
 *
 * A session tracks one story draft per conversation thread from first
 * mention through refinement to task creation. All functions here are pure;
 * engine calls and transport I/O live in bot.ts.
 */

import type { SourceInput, StoryDraft, SubtaskDraft } from "../engine/index.js";
import type { ChatPlatform } from "./types.js";

export type SessionStatus =
  | "generating" // engine call in flight (generate/edit/decompose)
  | "drafted" // draft posted, awaiting edits or approval
  | "creating" // backend createTask in flight
  | "done" // task created; kept briefly to answer late replies
  | "failed"; // engine error surfaced; next message retries

export interface DraftSession {
  /** Thread key from {@link BotThread.key}; one session per thread. */
  key: string;
  platform: ChatPlatform;
  source: SourceInput;
  draft?: StoryDraft;
  subtasks?: SubtaskDraft[];
  issueType: string;
  projectKey?: string;
  status: SessionStatus;
  createdTaskUrl?: string;
  createdTaskKey?: string;
  /** Edit prompts applied so far, newest last (debugging/context). */
  history: string[];
  updatedAt: number;
}

export const DEFAULT_ISSUE_TYPE = "Task";

/**
 * Create a fresh session for a thread from the user's initial idea text.
 *
 * @param key - Thread key ({@link BotThread.key}).
 * @param platform - Chat platform the thread lives on.
 * @param text - Rough idea to generate a story from.
 * @param now - Timestamp (injectable for tests).
 */
export function createSession(
  key: string,
  platform: ChatPlatform,
  text: string,
  now: number,
): DraftSession {
  return {
    key,
    platform,
    source: { type: "prompt", content: text },
    issueType: DEFAULT_ISSUE_TYPE,
    status: "generating",
    history: [],
    updatedAt: now,
  };
}

/** What an in-thread reply asks the bot to do. */
export type ReplyIntent =
  | { kind: "approve" }
  | { kind: "decompose" }
  | { kind: "set-type"; issueType: string }
  | { kind: "set-project"; projectKey: string }
  | { kind: "help" }
  | { kind: "edit"; prompt: string };

const APPROVE_PHRASES = new Set([
  "create",
  "approve",
  "approved",
  "ship it",
  "lgtm",
  "yes",
  "ok",
  "okay",
  "go",
  "👍",
  "✅",
]);

const DECOMPOSE_PHRASES = new Set([
  "split",
  "decompose",
  "split into subtasks",
  "break it down",
  "break down",
  "subtasks",
]);

/**
 * Classify a reply in a drafted thread. Anything that isn't a recognized
 * short command is treated as a natural-language edit request.
 */
export function classifyReply(text: string): ReplyIntent {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  if (APPROVE_PHRASES.has(normalized)) return { kind: "approve" };
  if (DECOMPOSE_PHRASES.has(normalized)) return { kind: "decompose" };
  if (normalized === "help" || normalized === "?") return { kind: "help" };

  const typeMatch = /^type[:\s]+(.+)$/i.exec(text.trim());
  if (typeMatch?.[1]) return { kind: "set-type", issueType: typeMatch[1].trim() };

  const projectMatch = /^project[:\s]+(\S+)$/i.exec(text.trim());
  if (projectMatch?.[1]) return { kind: "set-project", projectKey: projectMatch[1].trim() };

  return { kind: "edit", prompt: text.trim() };
}

/** Emoji names that approve a draft when reacted onto the draft message. */
export const APPROVE_EMOJI = new Set(["white_check_mark", "+1", "thumbsup", "✅", "👍"]);

/** True when a session has been idle past its TTL and should be swept. */
export function isExpired(session: DraftSession, now: number, ttlMs: number): boolean {
  return now - session.updatedAt > ttlMs;
}
