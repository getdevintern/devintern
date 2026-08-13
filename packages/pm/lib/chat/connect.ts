/**
 * `devpm connect <platform>`: guided chat platform setup.
 *
 * Collects and validates bot tokens, then persists them to
 * `.devintern-pm/.env`. Tokens never leave this machine.
 */

import { join } from "node:path";
import { resolveConfigDir } from "@devintern/utils";
import { mkdir, pathExists, readFile, writeFile } from "../runtime/fs.js";
import { askText } from "../runtime/stdin.js";
import { buildSlackManifestUrl } from "./manifest.js";

/** Platforms `devpm connect` can set up. */
export const CONNECTABLE_PLATFORMS = ["telegram", "slack"] as const;
export type ConnectablePlatform = (typeof CONNECTABLE_PLATFORMS)[number];

/**
 * Insert or replace `KEY=value` lines in an env file, preserving everything
 * else. Creates the file (and directory) when missing.
 */
export async function upsertEnvVars(envPath: string, vars: Record<string, string>): Promise<void> {
  let content = "";
  if (await pathExists(envPath)) {
    content = await readFile(envPath);
  } else {
    await mkdir(join(envPath, ".."));
  }

  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^[ \\t]*#?[ \\t]*${key}=.*$`, "m");
    content = pattern.test(content)
      ? content.replace(pattern, line)
      : `${content}${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}${line}\n`;
  }

  await writeFile(envPath, content);
}

interface TelegramGetMeResponse {
  ok: boolean;
  result?: { username?: string };
  description?: string;
}

/** Validate a Telegram bot token against the Bot API. */
async function validateTelegramToken(token: string): Promise<string> {
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const payload = (await response.json()) as TelegramGetMeResponse;
  if (!payload.ok || !payload.result?.username) {
    throw new Error(payload.description ?? "Telegram rejected the token");
  }
  return payload.result.username;
}

async function connectTelegram(envPath: string): Promise<void> {
  console.log(`
🤖 Connect Telegram

1. Open Telegram and message @BotFather
2. Send /newbot and follow the prompts (pick a name and a username)
3. BotFather replies with an HTTP API token like 110201543:AAHdqTcv...
`);

  const token = await askText("Paste your bot token: ");
  if (!token) {
    console.error("❌ No token provided");
    process.exit(1);
  }

  console.log("🔍 Validating token…");
  let username: string;
  try {
    username = await validateTelegramToken(token);
  } catch (error) {
    console.error(`❌ Token validation failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
    return;
  }

  await upsertEnvVars(envPath, { TELEGRAM_BOT_TOKEN: token });
  console.log(`✅ Connected @${username}; token saved to ${envPath}`);
  console.log(`\nNext: run \`devpm serve\`, then DM @${username} a rough task idea.`);
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  team?: string;
}

async function slackApi(method: string, token: string): Promise<SlackApiResponse> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await response.json()) as SlackApiResponse;
}

async function connectSlack(envPath: string): Promise<void> {
  console.log(`
🤖 Connect Slack

1. Open this link to create the app with everything pre-configured
   (bot user, /devpm command, Socket Mode, scopes):

${buildSlackManifestUrl()}

2. Pick your workspace, review the manifest, and click Create
3. On the app page: Settings → Install App → Install to Workspace
4. Copy the Bot User OAuth Token (starts with xoxb-)
5. Then: Settings → Basic Information → App-Level Tokens →
   Generate Token with the connections:write scope (starts with xapp-)
`);

  const botToken = await askText("Paste the Bot User OAuth Token (xoxb-…): ");
  if (!botToken.startsWith("xoxb-")) {
    console.error("❌ That doesn't look like a bot token (expected xoxb-…)");
    process.exit(1);
  }
  const appToken = await askText("Paste the App-Level Token (xapp-…): ");
  if (!appToken.startsWith("xapp-")) {
    console.error("❌ That doesn't look like an app-level token (expected xapp-…)");
    process.exit(1);
  }

  console.log("🔍 Validating tokens…");
  const auth = await slackApi("auth.test", botToken);
  if (!auth.ok) {
    console.error(`❌ Bot token rejected by Slack: ${auth.error ?? "unknown error"}`);
    process.exit(1);
  }
  const socket = await slackApi("apps.connections.open", appToken);
  if (!socket.ok) {
    console.error(
      `❌ App-level token rejected (needs connections:write): ${socket.error ?? "unknown error"}`,
    );
    process.exit(1);
  }

  await upsertEnvVars(envPath, {
    SLACK_BOT_TOKEN: botToken,
    SLACK_APP_TOKEN: appToken,
  });
  console.log(`✅ Connected to ${auth.team ?? "your workspace"}; tokens saved to ${envPath}`);
  console.log(
    "\nNext: run `devpm serve`, invite @devpm to a channel, and mention it with a rough task idea (or use /devpm).",
  );
}

/**
 * Run the guided connect flow for a chat platform.
 *
 * Exits the process with code 1 on unknown platforms or validation failure.
 */
export async function runConnect(platform: string): Promise<void> {
  const configDir = resolveConfigDir({ configDirName: ".devintern-pm" });
  const envPath = join(configDir, ".env");

  switch (platform) {
    case "telegram":
      await connectTelegram(envPath);
      return;
    case "slack":
      await connectSlack(envPath);
      return;
    default:
      console.error(
        `❌ Unknown platform "${platform}". Supported: ${CONNECTABLE_PLATFORMS.join(", ")}`,
      );
      process.exit(1);
  }
}
