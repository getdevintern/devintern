/**
 * Chat integration types: the seam between platform transports (Chat SDK
 * wrapping Slack, Telegram, ...) and the bot's session logic.
 *
 * Like the engine, this module must stay free of ink/React and of any
 * platform SDK imports so the bot logic can run in any Node host and be
 * tested with fake threads.
 */

export type ChatPlatform = "slack" | "telegram";

export interface OutgoingButton {
  actionId: string;
  label: string;
  value?: string;
}

/** Outbound message content; `text` is generic markdown the transport renders natively. */
export interface OutgoingMessage {
  text: string;
  buttons?: OutgoingButton[];
}

/** Handle to a message the bot posted, sufficient to edit it in place. */
export interface DraftMessageHandle {
  edit(msg: OutgoingMessage): Promise<void>;
}

/**
 * Minimal view of a conversation thread the bot logic depends on.
 * Implemented over Chat SDK threads in production and by fakes in tests.
 */
export interface BotThread {
  /** Stable unique conversation key (Chat SDK thread id: `adapter:channel:thread`). */
  key: string;
  platform: ChatPlatform;
  /** Route future thread messages to the bot (persisted across restarts). */
  subscribe(): Promise<void>;
  post(msg: OutgoingMessage): Promise<DraftMessageHandle>;
  /** Best-effort typing indicator; no-op where unsupported. */
  startTyping(): Promise<void>;
}
