---
title: "Slack Integration"
description: "Try the alpha @devintern/pm integration for creating tracker tasks from Slack"
section: "Create Tasks"
order: 12
sidebarHidden: true
dateModified: 2026-11-18
tags: ["slack", "devintern/pm", "integration", "chat", "bot"]
---

# Slack Integration (Alpha)

> **Alpha:** The Slack bot is experimental. Expect bugs and breaking changes.

Draft and file tracker tasks from Slack with the [devpm chat bot](./chat-bot.md). You create your own Slack app from a pre-filled manifest; it uses Socket Mode, so no public URL or app review is needed.

## Create the app

From your project directory:

```bash
devpm connect slack
```

The command prints a link to Slack's "create an app from manifest" page with the bot user, `/devpm` slash command, Socket Mode, and scopes already filled in.

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

The bot replies with a draft in a thread. Refine it by replying, then approve with the **Create** button, a `create` reply, or a checkmark reaction. See [Using the bot](./chat-bot.md#using-the-bot) for thread commands.

## Troubleshooting

- Bot token rejected: reinstall the app to the workspace and copy the fresh `xoxb-` token.
- App-level token rejected: the `xapp-` token must have the `connections:write` scope.
- No response to channel messages: the bot must be invited to the channel, and new conversations start with a mention or `/devpm`.
