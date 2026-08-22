---
title: "@devintern/code Quick Start"
sidebarLabel: "Quick Start"
description: "Install @devintern/code and turn your first tracker ticket into a pull request."
section: "Code"
order: 1
dateModified: 2026-08-02
tags: ["devintern/code", "quick start", "jira", "trello", "cli"]
---

# @devintern/code Quick Start

**@devintern/code** is your AI intern for automatically implementing tasks from your task tracker. It fetches task details, creates feature branches, runs your AI agent, commits changes, and optionally creates pull requests, all from a single command.

Supported task trackers today: **Jira** (default), **Linear**, **Trello**, **Asana**, **Azure DevOps**, **GitHub Issues**, and **local markdown files** (no PM account required).

## Prerequisites

- **[Bun](https://bun.sh) runtime** (required to run @devintern/code)
- Task tracker account with API access (Jira, Linear, Trello, Asana, Azure DevOps, or GitHub Issues), or local markdown files with no account at all
- AI agent CLI installed (e.g., Claude Code, OpenCode, Codex, Cursor)
- Git repository for your project

## Installation

Install globally with Bun:

```bash
# Install Bun if not already installed
curl -fsSL https://bun.sh/install | bash

# Install @devintern/code globally
bun install -g @getdevintern/code
```

## Initialize Configuration

Navigate to your project directory and run:

```bash
devintern init
```

In a terminal, this starts an interactive setup wizard that:

- Detects an existing @devintern/pm configuration (`.devintern-pm/.env`) in the same project and offers to reuse those tracker credentials, so you skip straight to validation
- Asks which task tracker you use — local **markdown files** lead the menu as the zero-account way to try DevIntern in minutes, followed by Jira, Linear, GitHub Issues, Azure DevOps, Asana, and Trello
- Links you directly to the provider's token creation page and prompts for each credential, with a pointer to the matching setup guide in these docs
- Validates the connection with a real API call before finishing (you can retry, edit values, or skip)
- Offers an optional GitHub token for pull request creation
- Detects installed AI agent CLIs (and warns with install steps when none are found)
- Offers to sign in to DevIntern on the spot (`devintern login` equivalent)
- Finishes with a readiness checklist so your first run cannot fail on something setup could have caught
- Writes your answers to `.devintern-code/.env`, creates `settings.json` for per-project configuration, and adds a whitelist block to your `.gitignore` (`.devintern-code/*` plus `!settings.json` and `!.env.example` exceptions) so credentials and local run state never get committed, while `settings.json` and the `.env.example` template stay trackable

For scripted or CI setups, pass `--yes` (or `--no-interactive`) to skip the prompts and write a commented configuration template instead:

```bash
devintern init --yes
```

### Re-running init on an existing setup

Running `devintern init` in an already-configured project no longer refuses — it offers a short menu: **update** your current tracker's credentials (stored values become Enter-to-keep defaults), **switch** to a different tracker (your GitHub PR token carries over), or exit without changes. Updates are merged into `.env`, so comments, custom variables, and previously-skipped optionals are preserved.

## Connect Your Task Tracker

The wizard handles credentials for you. If you skip `init`, running a task in an unconfigured project from an interactive terminal offers to launch the guided setup inline before failing. If you used `--yes`, or want to change trackers later, edit `.devintern-code/.env` for the tracker you use. Optionally edit `.devintern-code/settings.json` for status or list transitions after a run.

| Tracker            | When to use                                               | Setup guide                                                 |
| ------------------ | --------------------------------------------------------- | ----------------------------------------------------------- |
| **Jira** (default) | Jira Cloud issues, JQL batch runs, story point estimation | [Jira Integration](./jira-integration.md)                   |
| **Linear**         | Linear issues by ID or URL, IssueFilter batch runs        | [Linear Integration](./linear-integration.md)               |
| **Trello**         | Trello cards by short link or URL                         | [Trello Integration](./trello-integration.md)               |
| **Asana**          | Asana tasks with project section transitions              | [Asana Integration](./asana-integration.md)                 |
| **Azure DevOps**   | Azure DevOps work items by ID or URL                      | [Azure DevOps Integration](./azure-devops-integration.md)   |
| **GitHub Issues**  | GitHub issues with status labels, PRs in the same repo    | [GitHub Issues Integration](./github-issues-integration.md) |
| **Markdown files** | Local `.md` specs, no PM account needed                   | [Markdown File Tasks](./markdown-tasks.md)                  |

**Jira:** add `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN`. You do not need to set `TASK_TRACKER` (it defaults to `jira`).

**Trello:** set `TASK_TRACKER=trello` plus `TRELLO_API_KEY` and `TRELLO_API_TOKEN`.

Shared options (GitHub/Bitbucket PRs, agent harness, output directory) are covered in [Configuration](./configuration.md).

## First Run

Not sure everything is wired up? Run `devintern doctor` for a readiness check (agent CLI, tracker credentials, sign-in) with a fix hint per issue.

Run `devintern` with a task reference from your configured tracker:

**Jira**

```bash
devintern PROJ-123 --create-pr
```

**Trello** (`TASK_TRACKER=trello` in `.devintern-code/.env`)

```bash
devintern AbCdEf12 --create-pr
```

Every run:

1. **Fetches** task details (description, comments, attachments where supported)
2. **Transitions** the task (Jira status or Trello list, when configured in `settings.json`)
3. **Creates** a feature branch (`feature/proj-123`)
4. **Runs** a clarity check (skippable with `--skip-clarity-check`)
5. **Executes** your AI agent with formatted task context
6. **Commits** changes automatically after successful implementation
7. **Posts** a summary back to your task tracker

## What's Next?

- [Usage](./usage.md): CLI flags, query-based batch runs, git, and pull requests
- [Automated task processing](./automated-task-processing.md): scheduled runs with systemd or cron
