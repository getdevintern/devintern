---
title: "Slack Integration"
description: "Try the alpha @devintern/pm integration for creating tracker tasks from Slack"
section: "PM"
order: 12
dateModified: 2026-08-12
tags: ["slack", "devintern/pm", "integration", "chat", "bot"]
---

# Slack Integration (Alpha)

> **Alpha:** The Slack chat bot is experimental and may not work properly. Expect bugs and breaking changes, and do not rely on it for critical workflows yet.

Draft and file tracker tasks without leaving Slack. Your team mentions the bot with a rough idea, refines the AI draft in a thread, and approves it to create the task in Jira, Linear, or any other supported tracker.

The bot uses Slack's Socket Mode, so the [devpm chat bot](./chat-bot.md) connects outbound from your machine: no public URL, no request signing setup, and no app review. You create your own Slack app from a pre-filled manifest, so all tokens stay in your workspace and your `.devintern-pm/.env`.

## Create the app

From your project directory:

```bash
devpm connect slack
```

The command prints a link that opens Slack's "create an app from manifest" page with everything pre-configured: the bot user, the `/devpm` slash command, Socket Mode, and the required scopes (`app_mentions:read`, `chat:write`, `commands`, `reactions:read`, `reactions:write`, plus channel, group, and DM history).

1. Open the printed link, pick your workspace, and click Create
2. Install the app: Settings, then Install App, then Install to Workspace
3. Copy the Bot User OAuth Token (starts with `xoxb-`)
4. Generate an app-level token: Settings, then Basic Information, then App-Level Tokens, with the `connections:write` scope (starts with `xapp-`)
5. Paste both tokens back into the `devpm connect slack` prompt

The command validates both tokens against the Slack API and saves them as `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `.devintern-pm/.env`.

## Use it

```bash
devpm serve
```

Invite the bot to a channel, then either:

- Mention it: `@devpm users should be able to reset their password`
- Or use the slash command: `/devpm users should be able to reset their password`

The bot posts a drafted story in a thread with Create and Split into subtasks buttons. Reply in the thread to refine the draft, `type Bug` to change the issue type, `project PROJ` to retarget it, and approve with the Create button, a `create` reply, or a checkmark reaction. The bot posts the task link when it is filed.

## Troubleshooting

- Bot token rejected: reinstall the app to the workspace and copy the fresh `xoxb-` token.
- App-level token rejected: the `xapp-` token must have the `connections:write` scope.
- No response to channel messages: the bot must be invited to the channel, and new conversations start with a mention or `/devpm`.
