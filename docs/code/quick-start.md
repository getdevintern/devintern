---
title: "@devintern/code Quick Start"
sidebarLabel: "Quick Start"
description: "Install @devintern/code and turn a markdown task or tracker ticket into working code."
section: "Automation"
order: 0
dateModified: 2026-09-01
tags: ["devintern/code", "quick start", "jira", "trello", "cli"]
---

# @devintern/code Quick Start

**@devintern/code** is your AI intern for automatically implementing tasks. Point it at a local markdown file or a ticket in your task tracker, and it runs your AI agent, creates a feature branch, commits the changes, and can open a pull request.

Supported task trackers today: **Jira** (default), **Linear**, **Trello**, **Asana**, **Azure DevOps**, **GitHub Issues**, and **local markdown files** (no PM account required).

## Prerequisites

- **[Bun](https://bun.sh) runtime** (required to run @devintern/code)
- A local markdown file, or a task tracker account with API access (Jira, Linear, Trello, Asana, Azure DevOps, or GitHub Issues)
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

## Run Your First Task

The fastest way to try DevIntern is with a markdown file. Create `first-task.md` in your repository:

```markdown
# Add a health check

Add a `/health` endpoint that returns a successful JSON response.

## Acceptance criteria

- `GET /health` returns HTTP 200
- The response body is `{ "status": "ok" }`
- Add a test for the endpoint
```

Then point DevIntern at it:

```bash
devintern ./first-task.md
```

No task tracker account or credentials are required. DevIntern uses the filename as the task key, creates a feature branch, runs your installed AI agent, and commits a successful implementation. Add `--create-pr` once you have configured a repository host token.

Every run:

1. Loads the task and checks that it is clear enough to implement
2. Creates a feature branch (`feature/first-task`)
3. Runs your AI agent with the task and repository context
4. Commits changes after a successful implementation
5. Optionally opens a pull request and updates the task tracker

See [Markdown File Tasks](./markdown-tasks.md) for optional frontmatter, status tracking, and batch queries.

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

## Run a Tracker Task

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

## What's Next?

Turn the successful one-off run into a worker that watches for ready tasks and opens pull requests without you starting each run:

```bash
devintern worker init
devintern worker
```

- [Set up the worker](./worker.md): automate task pickup, pull request feedback, and recurring work
- [CLI reference](./usage.md): run individual tasks and queries on demand
- [Tracker setup guides](#connect-your-task-tracker): open the guide for the tracker you selected during setup
