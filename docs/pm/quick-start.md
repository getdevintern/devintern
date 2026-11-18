---
title: "DevIntern PM Quick Start"
sidebarLabel: "Quick Start"
description: "Use when installing DevIntern PM (desktop app or CLI) and creating your first AI-drafted ticket in Jira, Linear, Trello, or another tracker."
section: "Create Tasks"
order: 0
dateModified: 2026-11-18
tags: ["devintern/pm", "quick start", "jira", "linear", "cli"]
---

# DevIntern PM Quick Start

DevIntern PM turns Figma designs, error logs, or written requirements into AI-drafted stories and files them in your tracker.

Most people start with the [DevIntern PM desktop app](https://devintern.com/pm-desktop/). On launch it checks that **Git** and at least one supported agent CLI are installed; if one is missing, install it and choose **Check again**. Continue here to use the `devpm` CLI instead.

## Prerequisites

- **[Node.js](https://nodejs.org) 20 or newer**: Required to run @devintern/pm ([Bun](https://bun.sh) works too)
- **Git**: Required for project folders, GitHub connect, and update-from-remote
- AI agent CLI installed and configured (e.g., Claude Code, OpenCode, Codex, Cursor)
- An account on a supported tracker (Jira, Linear, Trello, Azure DevOps, Asana, GitHub Issues, or GitLab), or use local Markdown files
- **For Figma sources**: Claude Code with the [Figma MCP server](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/) configured

## Installation

```bash
npm install -g @getdevintern/pm
# or
bun install -g @getdevintern/pm
```

## Initialize Configuration

From your project directory:

```bash
devpm init
```

The wizard asks which tracker you use, links to its token page, validates the connection, and writes `.devintern-pm/.env` (adding it to `.gitignore`). If the project already has a DevIntern Code config (`.devintern-code/.env`), it offers to reuse those tracker credentials. Otherwise it can reuse credentials from your DevIntern workspace `.env` (`~/.devintern/.env` by default). Project-specific values (project key, repository, board, team key, task directory) are always asked for in the current project.

To set up credentials by hand, follow your tracker's guide: [Jira](./jira-integration.md), [Linear](./linear-integration.md), [Trello](./trello-integration.md), [Asana](./asana-integration.md), [Azure DevOps](./azure-devops-integration.md), [GitHub Issues](./github-integration.md), or [GitLab](./gitlab-integration.md). For scripts or CI, `devpm init --yes` writes a template. It takes the tracker from `.devintern-code/.env` or your workspace (`workspace.toml` first), and leaves `TASK_TRACKER` commented out when it can't tell, so a workspace you set up later still applies.

## First Run

```bash
devpm --interactive
```

The terminal UI walks you through choosing a source (Figma URL, error log, or prompt), adding instructions, and confirming the draft before it is filed. Press `Ctrl+G` to switch agents or `Ctrl+P` to switch projects at any step. See the [Usage guide](./usage.md#interactive-mode) for each step and the non-interactive flags.

## What's Next?

- [Configure your tracker and agent](./configuration.md)
- [Learn CLI usage patterns](./usage.md)
- [Create tasks from Slack or Telegram](./chat-bot.md)
