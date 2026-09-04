---
title: "@devintern/pm Quick Start"
sidebarLabel: "Quick Start"
description: "Install @devintern/pm and create your first AI-drafted ticket in your tracker."
section: "Create Tasks"
order: 0
dateModified: 2026-09-01
tags: ["devintern/pm", "quick start", "jira", "linear", "cli"]
---

# @devintern/pm Quick Start

**@devintern/pm** automates story and task creation across multiple project management tools with AI. Transform Figma designs, error logs, or requirements into well-structured issues in seconds.

For the primary visual workflow, [download DevIntern PM](https://devintern.com/pm-desktop/). The desktop app checks on launch that **Git** and **at least one supported agent CLI** are on your PATH (including common GUI-launch locations). If something is missing, install it and choose **Check again**. Continue here if you prefer to work in the terminal.

## Prerequisites

- **[Node.js](https://nodejs.org) 20 or newer**: Required to run @devintern/pm ([Bun](https://bun.sh) works too)
- **Git**: Required for project folders, GitHub connect, and update-from-remote
- AI agent CLI installed and configured (e.g., Claude Code, OpenCode, Codex, Cursor)
- Account with at least one supported PM tool (Jira, Linear, Trello, Azure DevOps, Asana, or GitHub)
- **For Figma functionality**: [Figma MCP server](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/) must be installed and configured in your AI agent (Claude Code only)

## Installation

Install globally with npm:

```bash
npm install -g @getdevintern/pm
```

Or with Bun:

```bash
bun install -g @getdevintern/pm
```

## Initialize Configuration

Navigate to your project directory and run:

```bash
devpm init
```

In a terminal, this starts an interactive setup wizard that:

- Detects an existing @devintern/code configuration (`.devintern-code/.env`) in the same project and offers to reuse those tracker credentials, so you skip straight to validation
- Asks which tracker you use (Jira, Linear, Trello, Azure DevOps, Asana, GitHub Issues, GitLab, or markdown files)
- Links you directly to the provider's token creation page and prompts for each credential, with a pointer to the matching setup guide in these docs
- Validates the connection with a real API call before finishing (you can retry, edit values, or skip)
- Writes your answers to `.devintern-pm/.env` and updates your `.gitignore` to exclude `.devintern-pm/.env` (to prevent leaking secrets)

If you need to create credentials manually, use the setup guide for your tracker: [Jira](./jira-integration.md), [Linear](./linear-integration.md), [Trello](./trello-integration.md), [Asana](./asana-integration.md), [Azure DevOps](./azure-devops-integration.md), [GitHub Issues](./github-integration.md), or [GitLab](./gitlab-integration.md).

For scripted or CI setups, pass `--yes` (or `--no-interactive`) to skip the prompts and write the configuration template instead. The non-interactive path also migrates matching values from `.devintern-code/.env` if present:

```bash
devpm init --yes
```

## First Run

The interactive mode provides a step-by-step terminal UI for creating tasks. This is the recommended way to use @devintern/pm:

```bash
devpm --interactive
```

You can also pick a different agent up front:

```bash
devpm --interactive --harness opencode
```

In interactive mode, press `Ctrl+G` at any step to switch among installed agent harnesses without restarting.

The interactive mode will guide you through:

1. **Source type selection**: Choose between Figma URL, error log, or free-form prompt
2. **Source input**: Enter your Figma URL, error log, or requirements
3. **Custom instructions** (optional): Add additional requirements or focus areas
4. **Epic linking** (optional): Link to an existing Jira epic
5. **Issue type** (Jira, Azure DevOps, GitHub, Markdown only): Select Task, Story, Bug, Epic, or enter a custom type. Task is the default; press Enter to accept it. This step is skipped for Linear, Trello, and Asana, which do not support setting an issue type.
6. **Prompt style**: Choose between PM style or Technical style
7. **Confirmation**: Review your configuration before proceeding

## What's Next?

- [Configure your PM backend](./configuration.md)
- [Learn CLI usage patterns](./usage.md)
- [Create tasks from Slack or Telegram](./chat-bot.md)
