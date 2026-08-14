---
title: "Chat Bot Alpha (devpm serve)"
description: "Try the alpha devpm chat bot for creating and refining tracker tasks from Slack or Telegram"
section: "PM"
order: 10
dateModified: 2026-08-12
tags: ["devintern/pm", "chat", "slack", "telegram", "bot"]
---

# Chat Bot Alpha (devpm serve)

> **Alpha:** The chat bot is experimental and may not work properly. Expect bugs and breaking changes, and do not rely on it for critical workflows yet.

`devpm serve` runs a chat bot where your team already talks. Mention the bot with a rough idea, get an AI-drafted story back in a thread, refine it in plain language, and approve it to file the task in your tracker (Jira, Linear, Trello, Azure DevOps, Asana, GitHub Issues, or Markdown).

The bot runs entirely on your machine. It connects outbound to Slack (Socket Mode) and Telegram (long polling), so you need no public URL, no webhook setup, and no hosted service. Bot tokens, tracker credentials, and the AI agent all stay local.

## How it works

1. Mention the bot with an idea: `@devpm users should be able to reset their password` (Slack), or just DM your bot on Telegram. On Slack you can also use `/devpm <idea>`.
2. The bot replies in a thread with a draft: a title, a description with acceptance criteria, and Create / Split into subtasks buttons.
3. Reply in the thread to refine it: "make the acceptance criteria stricter", "add a rollout plan". Each reply regenerates the draft in place.
4. Optional thread commands:
   - `type Bug` or `type Story` changes the issue type
   - `project PROJ` targets a different project
   - `split` decomposes the story into subtasks
   - `help` shows a reminder of these commands
5. Approve it: reply `create`, react with a checkmark, or press the Create button. The bot files the task (and any subtasks) and posts the link.

Each thread holds one draft. After the task is created, mention the bot again to start a new one. Idle drafts expire after 24 hours (configurable via `DEVPM_CHAT_SESSION_TTL_HOURS`).

## Setup

Connect at least one platform from your project directory:

```bash
devpm connect telegram   # paste a BotFather token, ~2 minutes
devpm connect slack      # guided app creation from a pre-filled manifest
```

See the [Telegram integration](./telegram-integration.md) and [Slack integration](./slack-integration.md) guides for the full walkthroughs.

Then start the daemon:

```bash
devpm serve
```

The daemon needs the same setup as the CLI: a configured tracker and an installed AI agent (see [Configuration](./configuration.md)). Use `--platform slack` or `--platform telegram` to run a single platform when both are configured.

## Running it long-term

`devpm serve` is a plain foreground process. Run it under your preferred supervisor:

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

Draft sessions and thread subscriptions persist to `.devintern-pm/`, so an in-progress draft survives a restart: reply in its thread and the bot picks it back up.

## Security notes

- Bot tokens live in `.devintern-pm/.env` next to your tracker credentials and never leave your machine.
- The bot connects outbound only. There is no inbound port, no public endpoint, and no DevIntern-hosted relay involved.
- Message content is sent to your configured AI agent the same way `devpm --prompt` is, using your own agent CLI and keys.

## Troubleshooting

- "No chat platform configured": run `devpm connect telegram` or `devpm connect slack` first.
- The bot connects but ignores channel messages on Slack: invite it to the channel, and start conversations by mentioning it.
- Drafts feel slow: generation runs your local AI agent, and the bot processes one agent run at a time. The progress message updates while it works.
