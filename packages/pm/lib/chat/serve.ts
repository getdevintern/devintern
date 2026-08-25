/**
 * `devpm serve`: long-running chat bot daemon.
 *
 * Connects the configured chat platforms (Slack Socket Mode, Telegram
 * long-polling) outbound from this machine — no public URL required — and
 * turns chat conversations into tracker tasks via the PM engine.
 */

import { join } from "node:path";
import { resolveConfigDir } from "@devintern/utils";
import { checkLicense, requireLicense } from "@devintern/license-check";
import { loadConfig, loadSupabaseConfig, migrateLegacyConfigDir } from "../config.js";
import { createEngine } from "../engine/index.js";
import { createChatBot } from "./bot.js";
import { createChatRuntime, detectChatTokens } from "./runtime.js";
import { createFileSessionStore } from "./store.js";
import type { ChatPlatform } from "./types.js";

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SHUTDOWN_DRAIN_CAP_MS = 30_000;

export interface ServeOptions {
  /** Restrict to specific platforms (default: all with tokens configured). */
  platforms?: ChatPlatform[];
  /** Model override passed to every agent call. */
  model?: string;
}

function log(line: string): void {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

/**
 * Run the chat bot daemon until SIGINT/SIGTERM.
 *
 * Exits the process with code 1 on configuration errors.
 */
export async function runServe(options: ServeOptions = {}): Promise<void> {
  await migrateLegacyConfigDir();
  const config = await loadConfig();

  // Same entitlement gate as the interactive CLI: every chat task creation
  // is human-approved, so chat serving counts as interactive use.
  const licenseResult = await checkLicense({
    productKey: "devintern/pm",
    supabaseConfig: loadSupabaseConfig(),
  });
  requireLicense(licenseResult);

  const tokens = detectChatTokens(process.env, options.platforms);
  if (!tokens.slack && !tokens.telegram) {
    console.error(
      "❌ No chat platform configured. Run `devpm connect telegram` or `devpm connect slack` first.",
    );
    process.exit(1);
  }

  // loadConfig() has loaded .devintern-pm/.env into process.env, so
  // AGENT_MODEL from the project config is visible here. The --model flag wins.
  const engine = await createEngine(config, {
    model: options.model ?? process.env.AGENT_MODEL,
  });
  const configDir = resolveConfigDir({ configDirName: ".devintern-pm" });
  const store = await createFileSessionStore(join(configDir, "chat-sessions.json"));

  const ttlHours = Number(process.env.DEVPM_CHAT_SESSION_TTL_HOURS) || 24;
  const bot = createChatBot({
    engine,
    store,
    log,
    sessionTtlMs: ttlHours * 60 * 60 * 1000,
  });

  const runtime = createChatRuntime({
    bot,
    botName: "devpm",
    tokens,
    statePath: join(configDir, "chat-state.json"),
    log,
  });

  try {
    await runtime.start();
  } catch (error) {
    console.error(
      `❌ Failed to connect chat platforms: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }

  log(`devpm chat bot running on: ${runtime.platforms.join(", ")}`);
  log(`Tracker: ${engine.backendName} · Agent: ${config.agent.harness.displayName}`);
  log("Mention the bot (or DM it on Telegram) with a rough idea to draft a task.");

  const sweeper = setInterval(() => {
    bot.sweepExpiredSessions().catch(() => {});
  }, SWEEP_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, draining in-flight work (max ${SHUTDOWN_DRAIN_CAP_MS / 1000}s)…`);
    clearInterval(sweeper);
    await Promise.race([
      bot.drain(),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_CAP_MS)),
    ]);
    await runtime.stop().catch(() => {});
    await store.close().catch(() => {});
    log("Bye.");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the process alive; transports drive the event loop from here.
  await new Promise(() => {});
}
