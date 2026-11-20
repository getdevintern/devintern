---
title: "Implement Azure DevOps Work Items with DevIntern Code"
sidebarLabel: "Azure DevOps Integration"
description: "Fetch Azure DevOps work items, run WIQL batches, implement with your coding agent, and post PRs and state transitions back."
section: "Automation"
order: 5
sidebarHidden: true
dateModified: 2026-11-18
tags: ["azure-devops", "devintern/code", "integration"]
---

# Implement Azure DevOps Work Items with DevIntern Code

DevIntern Code reads an Azure DevOps work item (description, tags, attachments, comments, and linked parent/child/related items), checks that it is clear enough to implement, moves it through workflow states, runs your coding agent, opens a pull request, and posts the result back on the work item. HTML descriptions are converted to Markdown for the agent, and comments are posted back as HTML.

## Prerequisites

- `@getdevintern/code` installed and a Git repository for your project
- A Personal Access Token (User settings → Personal access tokens) with **Work Items (Read and write)**

## Setup

Set in this repository's env file (`~/.devintern/env/<repo>.env`, created by `devintern init`):

| Variable               | Required | Description                                             |
| ---------------------- | -------- | ------------------------------------------------------- |
| `TASK_TRACKER`         | Yes      | `azure-devops`                                          |
| `AZURE_DEVOPS_ORG`     | Yes      | Organization: the segment after `dev.azure.com/`        |
| `AZURE_DEVOPS_PAT`     | Yes      | Personal Access Token                                   |
| `AZURE_DEVOPS_PROJECT` | Yes      | Name of the project that contains your work items       |

## Run a task

Pass a work item ID or full URL:

```bash
devintern 4211 --create-pr
devintern https://dev.azure.com/your-org/YourProject/_workitems/edit/4211 --create-pr
```

Batch runs take [WIQL](https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax), scoped to your project. The first 100 matches run in sequence:

```bash
devintern --query "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'New'" --create-pr
```

Use `--skip-clarity-check` to skip the feasibility check and `--skip-comments` to skip comments and state changes.

`--estimate` writes `Microsoft.VSTS.Scheduling.StoryPoints` (Agile template default). For another field, such as `Effort` in Scrum, set `story_points_field` for the project. See [Story Points Estimation](./story-points-estimation.md).

## Status mapping

Configure states under `[trackers]` in `~/.devintern/workspace.toml`, keyed by the project name. Names must match the states of your work item types (for example `New`, `Active`, `Resolved`, `Closed` in the Agile template).

```toml
[trackers.azure-devops.projects.YourProject]
in_progress_status = "Active"
todo_status = "New"
pr_status = "Resolved"
```

| Field              | When it is applied                                   |
| ------------------ | ---------------------------------------------------- |
| `in_progress_status` | Implementation starts (after the feasibility check)  |
| `pr_status`         | A pull request is created                            |
| `todo_status`       | The run is incomplete, fails, or hits the turn limit |

## Worker notes

- The [worker](./worker.md#polling-mode) polls with your WIQL as `[defaults].task_query`. PR'd work items are marked actioned and not re-implemented until they change; see [Tickets already actioned after a PR](./worker-troubleshooting.md#tickets-already-actioned-after-a-pr).
- For instant pickup, run `devintern worker connect azure-devops` to create work item service hooks through the [relay](./relay.md).

## Troubleshooting

| Symptom                                               | Fix                                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Missing required Azure DevOps environment variables` | Set `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PAT`, and `AZURE_DEVOPS_PROJECT`.                  |
| `Failed to move work item ... to state`               | States differ per process template and work item type; match them exactly in `[trackers]`. |
| 401 or 403 errors                                     | The PAT expired or lacks the Work Items (Read and write) scope for this organization.    |
