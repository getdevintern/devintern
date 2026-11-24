---
title: "Implement Linear Issues with DevIntern Code"
sidebarLabel: "Linear Integration"
description: "Fetch Linear issues, move workflow states, implement with your coding agent, and open PRs with summaries posted back."
section: "Automation"
order: 5
sidebarHidden: true
dateModified: 2026-11-18
tags: ["linear", "devintern/code", "integration"]
---

# Implement Linear Issues with DevIntern Code

DevIntern Code reads a Linear issue (description, labels, attachments, comments), checks that it is clear enough to implement, moves it through your workflow states, runs your coding agent, opens a pull request, and posts the result back on the issue.

## Prerequisites

- `@getdevintern/code` installed and a Git repository for your project
- A Linear Personal API key (it inherits your account's permissions)

## Setup

Create the key at [Linear API settings](https://linear.app/settings/api) under **Personal API keys**. It starts with `lin_api_` and is shown only once. Then set in this repository's env file (`~/.devintern/env/<repo>.env`, created by `devintern init`):

| Variable                  | Required | Description                                                                          |
| ------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `TASK_TRACKER`            | Yes      | `linear`                                                                             |
| `LINEAR_API_KEY`          | Yes      | Personal API key (`lin_api_...`)                                                     |
| `LINEAR_DEFAULT_TEAM_KEY` | No       | Default team key (e.g. `ENG`); `devintern worker init` uses it to seed a routing rule |

## Run a task

Pass identifiers (case-insensitive) or full issue URLs:

```bash
devintern ENG-42 --create-pr
devintern eng-42 eng-43 --create-pr
devintern https://linear.app/acme/issue/ENG-42/fix-login-bug --create-pr
```

Batch runs take a [Linear IssueFilter](https://studio.linear.app/graphql) as JSON, or plain text matched against titles. The first 50 matches run in sequence:

```bash
devintern --query '{"state":{"name":{"eq":"Todo"}},"team":{"key":{"eq":"ENG"}}}' --create-pr
devintern --query "login bug" --create-pr
```

Files on `uploads.linear.app` are downloaded for the agent; other links (Figma, Google Docs) are passed as links. Use `--skip-clarity-check` to skip the feasibility check and `--skip-comments` to skip comments and state changes.

`--estimate` writes Linear's native estimate field and posts the reasoning as a comment. See [Story Points Estimation](./story-points-estimation.md).

## Status mapping

Configure states under `[trackers]` in `~/.devintern/workspace.toml`, keyed by the team key (`ENG` in `ENG-42`). Names are matched case-insensitively against the team's workflow states.

```toml
[trackers.linear.projects.ENG]
in_progress_status = "In Progress"
todo_status = "Backlog"
pr_status = "In Review"
```

| Field              | When it is applied                                   |
| ------------------ | ---------------------------------------------------- |
| `in_progress_status` | Implementation starts (after the feasibility check)  |
| `pr_status`         | A pull request is created                            |
| `todo_status`       | The run is incomplete, fails, or hits the turn limit |

## Worker notes

- The [worker](./worker.md#polling-mode) polls with your IssueFilter as `[defaults].task_query`. PR'd issues are marked actioned and not re-implemented until they change; see [Tickets already actioned after a PR](./worker-troubleshooting.md#tickets-already-actioned-after-a-pr).
- For instant pickup, run `devintern worker connect linear` to register a webhook through the [relay](./relay.md).

## Troubleshooting

| Symptom                                           | Fix                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Missing required Linear environment variables`   | Set `LINEAR_API_KEY` in `~/.devintern/env/<repo>.env`.                                                          |
| Issue does not change state                       | Check the state names, and that the `[trackers]` key is the team key from the identifier.            |
| `Workflow state "In Progress" not found for team` | Fix the spelling; the error lists the team's available states.                                           |
| `Invalid Linear IssueFilter JSON`                 | Wrap the JSON in single quotes and validate it in the [Linear GraphQL explorer](https://studio.linear.app/graphql). |
