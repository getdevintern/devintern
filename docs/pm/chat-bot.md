---
title: "Chat Bot Alpha (devpm serve)"
description: "Try the alpha devpm chat bot for creating and refining tracker tasks from Slack or Telegram"
section: "Create Tasks"
order: 10
sidebarHidden: true
dateModified: 2026-11-18
tags: ["devintern/pm", "chat", "slack", "telegram", "bot"]
---

# Chat Bot Alpha (devpm serve)

> **Alpha:** The chat bot is experimental. Expect bugs and breaking changes, and don't rely on it for critical workflows yet.

`devpm serve` runs a Slack or Telegram bot that drafts tasks for your tracker. Mention it with a rough idea, refine the AI draft in a thread, and approve it to file the task.

The bot runs on your machine and connects outbound only, so there is no public URL, webhook, or hosted relay. Bot tokens live in `.devintern-pm/.env` next to your tracker credentials, and messages go to your own agent CLI the same way `devpm --prompt` does.

## Using the bot

1. Mention the bot with an idea: `@devpm users should be able to reset their password` (Slack), or just DM your bot on Telegram. On Slack you can also use `/devpm <idea>`.
2. The bot replies in a thread with a draft: a title, a description with acceptance criteria, and Create / Split into subtasks buttons.
3. Reply in the thread to refine it: "make the acceptance criteria stricter", "add a rollout plan". Each reply regenerates the draft in place.
4. Optional thread commands:
   - `type Bug` or `type Story` changes the issue type
   - `project PROJ` targets a different project
   - `split` decomposes the story into subtasks
   - `help` shows a reminder of these commands
5. Approve it: reply `create`, react with a checkmark, or press the Create button. The bot files the task (and any subtasks) and posts the link.

Each thread holds one draft; mention the bot again for a new one. Idle drafts expire after 24 hours (set `DEVPM_CHAT_SESSION_TTL_HOURS` to change this).

## Setup

Connect at least one platform from your project directory:

```bash
devpm connect telegram   # paste a BotFather token, ~2 minutes
devpm connect slack      # guided app creation from a pre-filled manifest
```

See the [Telegram](./telegram-integration.md) and [Slack](./slack-integration.md) guides for details. Then start the bot:

```bash
devpm serve
```

It needs the same setup as the CLI: a configured tracker and an installed agent (see [Configuration](./configuration.md)). With both platforms connected, `--platform slack` or `--platform telegram` runs just one.

## Running it long-term

`devpm serve` is a foreground process; run it under a supervisor such as tmux or systemd:

```bash
# tmux
tmux new -s devpm 'devpm serve'
```

```ini
# systemd (~/.config/systemd/user/devpm.service)
[Unit]
Description=devpm chat bot

[Service]
WorkingDirectory=/path/to/your/project
ExecStart=devpm serve
Restart=on-failure

[Install]
WantedBy=default.target
```

Drafts survive a restart: reply in the thread and the bot picks it back up.

## Troubleshooting

- "No chat platform configured": run `devpm connect telegram` or `devpm connect slack` first.
- The bot connects but ignores channel messages on Slack: invite it to the channel, and start conversations by mentioning it.
- Drafts feel slow: the bot runs one agent job at a time on your machine. The progress message updates while it works.
