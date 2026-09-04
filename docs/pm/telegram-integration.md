---
title: "Telegram Integration"
description: "Try the alpha @devintern/pm integration for creating tracker tasks from Telegram"
section: "PM"
order: 11
sidebarHidden: true
dateModified: 2026-08-12
tags: ["telegram", "devintern/pm", "integration", "chat", "bot"]
---

# Telegram Integration (Alpha)

> **Alpha:** The Telegram chat bot is experimental and may not work properly. Expect bugs and breaking changes, and do not rely on it for critical workflows yet.

Draft and file tracker tasks by messaging a Telegram bot. Setup takes about two minutes and needs no server, no public URL, and no webhook: the [devpm chat bot](./chat-bot.md) long-polls Telegram from your machine.

## Create the bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts (pick a display name and a username)
3. BotFather replies with an HTTP API token like `110201543:AAHdqTcv...`

## Connect it

From your project directory:

```bash
devpm connect telegram
```

Paste the token when prompted. The command validates it against the Telegram API and saves it as `TELEGRAM_BOT_TOKEN` in `.devintern-pm/.env`. The token stays on your machine.

## Use it

```bash
devpm serve
```

Then DM your bot a rough idea:

> users should be able to reset their password

The bot replies with a drafted story. Reply to refine it, `type Bug` to change the issue type, `split` for subtasks, and `create` (or a checkmark reaction) to file it. The bot answers with the task link.

## Group chats

The bot works best in DMs and in forum-style groups with topics. In plain groups, Telegram has no real threads, so keep one draft going at a time and reply directly to the bot's messages.

## Troubleshooting

- Token rejected: regenerate it with BotFather (`/token`) and run `devpm connect telegram` again.
- Bot does not respond in a group: make sure it is a member, and note that group privacy mode may hide messages that do not mention it. Disable privacy mode via BotFather (`/setprivacy`) or mention the bot explicitly.
