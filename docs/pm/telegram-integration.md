---
title: "Telegram Integration"
description: "Try the alpha @devintern/pm integration for creating tracker tasks from Telegram"
section: "Create Tasks"
order: 11
sidebarHidden: true
dateModified: 2026-11-18
tags: ["telegram", "devintern/pm", "integration", "chat", "bot"]
---

# Telegram Integration (Alpha)

> **Alpha:** The Telegram bot is experimental. Expect bugs and breaking changes.

Draft and file tracker tasks by messaging a Telegram bot. The [devpm chat bot](./chat-bot.md) polls Telegram from your machine, so no server or webhook is needed.

## Create the bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts (pick a display name and a username)
3. BotFather replies with an HTTP API token like `110201543:AAHdqTcv...`

## Connect it

From your project directory:

```bash
devpm connect telegram
```

Paste the token when prompted. The command validates it and saves it as `TELEGRAM_BOT_TOKEN` in `.devintern-pm/.env`.

## Use it

```bash
devpm serve
```

Then DM your bot a rough idea:

> users should be able to reset their password

The bot replies with a draft. Reply to refine it, and send `create` (or react with a checkmark) to file it. See [Using the bot](./chat-bot.md#using-the-bot) for other commands.

## Group chats

The bot works best in DMs and in forum-style groups with topics. In plain groups, Telegram has no real threads, so keep one draft going at a time and reply directly to the bot's messages.

## Troubleshooting

- Token rejected: regenerate it with BotFather (`/token`) and run `devpm connect telegram` again.
- Bot does not respond in a group: make sure it is a member, and note that group privacy mode may hide messages that do not mention it. Disable privacy mode via BotFather (`/setprivacy`) or mention the bot explicitly.
