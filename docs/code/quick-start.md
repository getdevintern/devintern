---
title: "DevIntern Code Quick Start"
sidebarLabel: "Quick Start"
description: "Use when installing DevIntern Code for the first time and running your first markdown task or tracker ticket through a coding agent."
section: "Automation"
order: 0
dateModified: 2026-11-18
tags: ["devintern/code", "quick start", "jira", "trello", "cli"]
---

# DevIntern Code Quick Start

DevIntern Code runs your AI coding agent on a task: a local markdown file or a ticket from Jira, Linear, Trello, Asana, Azure DevOps, GitHub Issues, or GitLab Issues. It creates a feature branch, commits the changes, and can open a pull request.

Prefer to set up from a chat? Install the [devintern-setup skill](agent-skills.md) and ask your coding agent to do it.

## Prerequisites

- [Bun](https://bun.sh)
- An AI agent CLI, such as Claude Code, Codex, OpenCode, or Cursor
- A git repository for your project
- A task tracker account with API access, or a markdown file

## 1. Install

```bash
curl -fsSL https://bun.sh/install | bash   # if Bun is not installed
bun install -g @getdevintern/code
```

## 2. Initialize

In your project directory:

```bash
devintern init
```

The wizard asks for your tracker, links to the page where you create its token, and validates the connection. It also detects installed agent CLIs and ends with a readiness checklist. Your answers go to `.devintern-code/.env`, which is added to `.gitignore`.

No tracker account yet? Choose **Markdown files**. Tasks are read from `./tasks` and need no credentials. See [Markdown File Tasks](./markdown-tasks.md).

Run `devintern init` again to update credentials or switch trackers. For scripts and CI, `devintern init --yes` writes a commented template instead of prompting.

## 3. Run one task

Check that everything is wired up:

```bash
devintern doctor
```

Then run a task. With Markdown, add `TASK-1.md` to your task directory and pass its name without the extension:

```bash
devintern TASK-1
```

With a tracker, pass the task reference:

```bash
devintern PROJ-123 --create-pr
```

Opening a pull request needs a source-control token; see [Configuration](./configuration.md#github-authentication).

## Next steps

- [Set up the worker](./worker.md#quick-start) so tasks are picked up, implemented, and turned into PRs automatically. Start with `devintern worker init`. This is the recommended setup for ongoing use, even with one repository.
- Open the guide for your tracker: [Jira](./jira-integration.md), [Linear](./linear-integration.md), [Trello](./trello-integration.md), [Asana](./asana-integration.md), [Azure DevOps](./azure-devops-integration.md), [GitHub Issues](./github-issues-integration.md), or [GitLab](./gitlab-integration.md).
- [CLI reference](./usage.md): flags, batch queries, and git behavior.
- [Reporting Bugs](./reporting-bugs.md): if a failure looks like a DevIntern defect, `devintern report` files a redacted report.
