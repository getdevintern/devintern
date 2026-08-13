import { describe, expect, test, afterEach } from "bun:test";
import { join } from "node:path";
import { getModuleDir } from "./lib/runtime/path.js";
import { readFile, rm, writeFile, mkdir } from "./lib/runtime/fs.js";
import { upsertEnvVars } from "./lib/chat/connect.js";
import { buildSlackManifestUrl, SLACK_APP_MANIFEST } from "./lib/chat/manifest.js";
import { detectChatTokens, stripLeadingMention } from "./lib/chat/runtime.js";

const TEST_DIR = join(getModuleDir(import.meta.url), "tmp-chat-connect");

afterEach(async () => {
  await rm(TEST_DIR);
});

describe("upsertEnvVars", () => {
  const envPath = join(TEST_DIR, ".env");

  test("creates the file and appends vars", async () => {
    await upsertEnvVars(envPath, { TELEGRAM_BOT_TOKEN: "123:abc" });
    expect(await readFile(envPath)).toContain("TELEGRAM_BOT_TOKEN=123:abc");
  });

  test("replaces existing values and preserves other lines", async () => {
    await mkdir(TEST_DIR);
    await writeFile(envPath, "TASK_TRACKER=jira\nTELEGRAM_BOT_TOKEN=old\n# comment\n");
    await upsertEnvVars(envPath, { TELEGRAM_BOT_TOKEN: "123:new" });

    const content = await readFile(envPath);
    expect(content).toContain("TASK_TRACKER=jira");
    expect(content).toContain("# comment");
    expect(content).toContain("TELEGRAM_BOT_TOKEN=123:new");
    expect(content).not.toContain("old");
  });

  test("activates a commented-out example line", async () => {
    await mkdir(TEST_DIR);
    await writeFile(envPath, "# SLACK_BOT_TOKEN=xoxb-your-bot-token\n");
    await upsertEnvVars(envPath, { SLACK_BOT_TOKEN: "xoxb-real" });

    const content = await readFile(envPath);
    expect(content).toContain("SLACK_BOT_TOKEN=xoxb-real");
    expect(content).not.toContain("xoxb-your-bot-token");
  });

  test("writes multiple vars at once", async () => {
    await upsertEnvVars(envPath, { SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" });
    const content = await readFile(envPath);
    expect(content).toContain("SLACK_BOT_TOKEN=xoxb-1");
    expect(content).toContain("SLACK_APP_TOKEN=xapp-1");
  });
});

describe("slack manifest", () => {
  test("manifest enables socket mode and the /devpm command", () => {
    expect(SLACK_APP_MANIFEST.settings.socket_mode_enabled).toBe(true);
    expect(SLACK_APP_MANIFEST.features.slash_commands[0]!.command).toBe("/devpm");
    expect(SLACK_APP_MANIFEST.oauth_config.scopes.bot).toContain("chat:write");
    expect(SLACK_APP_MANIFEST.settings.event_subscriptions.bot_events).toContain("app_mention");
  });

  test("manifest URL round-trips to valid JSON", () => {
    const url = buildSlackManifestUrl();
    expect(url).toStartWith("https://api.slack.com/apps?new_app=1&manifest_json=");
    const encoded = url.split("manifest_json=")[1]!;
    const parsed = JSON.parse(decodeURIComponent(encoded));
    expect(parsed.features.bot_user.display_name).toBe("devpm");
  });
});

describe("detectChatTokens", () => {
  test("detects platforms from env vars", () => {
    const tokens = detectChatTokens({
      TELEGRAM_BOT_TOKEN: "123:abc",
      SLACK_BOT_TOKEN: "xoxb-1",
      SLACK_APP_TOKEN: "xapp-1",
    });
    expect(tokens.telegram?.botToken).toBe("123:abc");
    expect(tokens.slack?.appToken).toBe("xapp-1");
  });

  test("ignores slack when only one of the two tokens is set", () => {
    const tokens = detectChatTokens({ SLACK_BOT_TOKEN: "xoxb-1" });
    expect(tokens.slack).toBeUndefined();
  });

  test("respects the platform filter", () => {
    const tokens = detectChatTokens(
      { TELEGRAM_BOT_TOKEN: "123:abc", SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" },
      ["telegram"],
    );
    expect(tokens.telegram).toBeDefined();
    expect(tokens.slack).toBeUndefined();
  });
});

describe("stripLeadingMention", () => {
  test("strips Slack-style mention prefixes", () => {
    expect(stripLeadingMention("<@U123ABC> add dark mode", "devpm")).toBe("add dark mode");
  });

  test("strips @botName prefixes", () => {
    expect(stripLeadingMention("@devpm add dark mode", "devpm")).toBe("add dark mode");
  });

  test("leaves other text untouched", () => {
    expect(stripLeadingMention("add dark mode for @devpm users", "devpm")).toBe(
      "add dark mode for @devpm users",
    );
  });
});
