/**
 * Chat SDK runtime: constructs the multi-platform Chat instance (Slack
 * Socket Mode, Telegram long-polling) and bridges its events onto the
 * transport-agnostic {@link ChatBot}.
 *
 * This is the only chat module that imports platform SDKs.
 */

import { Actions, Button, Card, CardText, Chat } from "chat";
import type { Thread } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { ChatBot } from "./bot.js";
import { APPROVE_EMOJI } from "./session.js";
import { FilePersistedState } from "./state.js";
import type { BotThread, ChatPlatform, OutgoingMessage } from "./types.js";

export interface ChatTokens {
  telegram?: { botToken: string };
  slack?: { botToken: string; appToken: string };
}

export interface ChatRuntimeOptions {
  bot: ChatBot;
  botName: string;
  tokens: ChatTokens;
  /** JSON file persisting thread subscriptions across restarts. */
  statePath: string;
  log?: (line: string) => void;
}

export interface ChatRuntime {
  readonly platforms: ChatPlatform[];
  /** Connect all transports and start receiving events. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Read chat platform tokens from the environment. */
export function detectChatTokens(
  env: Record<string, string | undefined>,
  only?: ChatPlatform[],
): ChatTokens {
  const tokens: ChatTokens = {};
  const wanted = (platform: ChatPlatform): boolean => !only || only.includes(platform);

  if (wanted("telegram") && env.TELEGRAM_BOT_TOKEN) {
    tokens.telegram = { botToken: env.TELEGRAM_BOT_TOKEN };
  }
  if (wanted("slack") && env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN) {
    tokens.slack = { botToken: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN };
  }
  return tokens;
}

/** Strip a leading @-mention of the bot from message text. */
export function stripLeadingMention(text: string, botName: string): string {
  return text
    .replace(/^\s*<@[^>]+>\s*/, "")
    .replace(new RegExp(`^\\s*@${botName}\\b\\s*`, "i"), "")
    .trim();
}

function toPostable(msg: OutgoingMessage) {
  if (msg.buttons && msg.buttons.length > 0) {
    return Card({
      children: [
        CardText(msg.text),
        Actions(
          msg.buttons.map((button) =>
            Button({ id: button.actionId, label: button.label, value: button.value }),
          ),
        ),
      ],
    });
  }
  return { markdown: msg.text };
}

function platformOf(threadId: string): ChatPlatform {
  return threadId.startsWith("telegram:") ? "telegram" : "slack";
}

function normalizeEmoji(value: string): string {
  return value.replace(/^:|:$/g, "").trim();
}

export function createChatRuntime(options: ChatRuntimeOptions): ChatRuntime {
  const { bot, botName, tokens, statePath } = options;
  const log = options.log ?? (() => {});

  const adapters: Record<string, unknown> = {};
  const platforms: ChatPlatform[] = [];
  if (tokens.slack) {
    adapters.slack = createSlackAdapter({
      mode: "socket",
      botToken: tokens.slack.botToken,
      appToken: tokens.slack.appToken,
    });
    platforms.push("slack");
  }
  if (tokens.telegram) {
    adapters.telegram = createTelegramAdapter({
      mode: "polling",
      botToken: tokens.telegram.botToken,
    });
    platforms.push("telegram");
  }
  if (platforms.length === 0) {
    throw new Error("No chat platform tokens configured");
  }

  const chat = new Chat({
    userName: botName,
    adapters: adapters as ConstructorParameters<typeof Chat>[0]["adapters"],
    state: new FilePersistedState(statePath),
    logger: "warn",
  });

  // Structural subset so threads from any handler generic (Thread<unknown>
  // in reaction/action events) are accepted.
  type AnyThread = Pick<Thread, "id" | "subscribe" | "startTyping" | "post">;

  function wrapThread(thread: AnyThread): BotThread {
    return {
      key: thread.id,
      platform: platformOf(thread.id),
      subscribe: async () => {
        await thread.subscribe();
      },
      startTyping: async () => {
        await thread.startTyping().catch(() => {});
      },
      post: async (msg) => {
        const sent = await thread.post(toPostable(msg));
        return {
          edit: async (updated) => {
            await sent.edit(toPostable(updated));
          },
        };
      },
    };
  }

  chat.onNewMention(async (thread, message) => {
    log(`[${platformOf(thread.id)}] mention in ${thread.id}`);
    await bot.handleMessage(wrapThread(thread), stripLeadingMention(message.text, botName), true);
  });

  chat.onDirectMessage(async (thread, message) => {
    log(`[${platformOf(thread.id)}] dm in ${thread.id}`);
    await bot.handleMessage(wrapThread(thread), stripLeadingMention(message.text, botName), true);
  });

  chat.onSubscribedMessage(async (thread, message) => {
    await bot.handleMessage(
      wrapThread(thread),
      stripLeadingMention(message.text, botName),
      Boolean(message.isMention),
    );
  });

  chat.onReaction(async (event) => {
    if (!event.added) return;
    const candidates = [String(event.emoji), event.rawEmoji ?? ""].map(normalizeEmoji);
    if (!candidates.some((name) => APPROVE_EMOJI.has(name))) return;
    log(`[${platformOf(event.thread.id)}] approve reaction in ${event.thread.id}`);
    await bot.handleApprove(wrapThread(event.thread));
  });

  chat.onSlashCommand("/devpm", async (event) => {
    const text = event.text.trim();
    if (!text) {
      await event.channel.post({ markdown: "Usage: `/devpm <rough task idea>`" });
      return;
    }
    // Slash commands don't create a visible message; anchor the session to a
    // fresh bot message so refinement happens in its thread.
    const author = event.user.fullName ?? event.user.userName ?? "someone";
    const sent = await event.channel.post({ markdown: `💡 Task idea from ${author}: ${text}` });
    log(`[slack] /devpm in ${sent.threadId}`);
    await bot.handleMessage(wrapThread(chat.thread(sent.threadId)), text, true);
  });

  chat.onAction(async (event) => {
    if (!event.thread) return;
    log(`[${platformOf(event.thread.id)}] action ${event.actionId} in ${event.thread.id}`);
    await bot.handleAction(wrapThread(event.thread), event.actionId);
  });

  return {
    platforms,
    async start() {
      await chat.initialize();
    },
    async stop() {
      await chat.shutdown();
    },
  };
}
