---
title: "Implement Asana Tasks with DevIntern Code"
sidebarLabel: "Asana Integration"
description: "Fetch Asana tasks, move project sections, implement with your coding agent, and post results back as comments."
section: "Automation"
order: 5
sidebarHidden: true
dateModified: 2026-11-18
tags: ["asana", "devintern/code", "integration"]
---

# Implement Asana Tasks with DevIntern Code

DevIntern Code reads an Asana task (notes, tags, attachments, comments), checks that it is clear enough to implement, moves it between project sections, runs your coding agent, opens a pull request, and posts the result back as a task comment.

## Prerequisites

- `@getdevintern/code` installed and a Git repository for your project
- An Asana personal access token from [Asana developer settings](https://app.asana.com/0/my-apps)

## Setup

Set in `.devintern-code/.env`:

| Variable                    | Required    | Description                                                                                       |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `TASK_TRACKER`              | Yes         | `asana`                                                                                           |
| `ASANA_API_TOKEN`           | Yes         | Personal access token                                                                             |
| `ASANA_DEFAULT_PROJECT_GID` | For worker  | Project GID from the project URL. Default project for queries and tasks outside a project; required for worker polling and relay |
| `ASANA_STORY_POINTS_FIELD`  | No          | Name of a numeric custom field (e.g. `Story Points`) that `--estimate` writes; without it, estimates are comment-only |

## Run a task

Pass a task GID or full task URL:

```bash
devintern 1200000000000001 --create-pr
devintern https://app.asana.com/0/1200000000000000/1200000000000001 --create-pr
```

Asana has no query language, so `--query` takes a small filter syntax. Remaining text matches task names:

```bash
devintern --query 'section:"To Do" completed:false' --create-pr
devintern --query 'project:1200000000000000 assignee:Ada login bug' --create-pr
```

Filters: `project:<gid>` (defaults to `ASANA_DEFAULT_PROJECT_GID`), `section:"<name>"`, `assignee:<name>`, `completed:true|false`. Queries read the first 100 tasks of the project (this works on free plans), so narrow large projects by section.

Use `--skip-clarity-check` to skip the feasibility check and `--skip-comments` to skip comments and section moves. For estimation, see [Story Points Estimation](./story-points-estimation.md).

## Status mapping

Asana has no workflow states, so statuses map to project sections. Configure them in `.devintern-code/settings.json`, keyed by the project GID. Section names are matched case-insensitively; a status of `done`, `completed`, or `closed` marks the task complete instead.

```json
{
  "asana": {
    "projects": {
      "1200000000000000": {
        "inProgressStatus": "In Progress",
        "todoStatus": "To Do",
        "prStatus": "In Review"
      }
    }
  }
}
```

| Field              | When it is applied                                   |
| ------------------ | ---------------------------------------------------- |
| `inProgressStatus` | Implementation starts (after the feasibility check)  |
| `prStatus`         | A pull request is created                            |
| `todoStatus`       | The run is incomplete, fails, or hits the turn limit |

## Worker notes

- [Worker polling](./worker.md#polling-mode) uses Asana's Events API and requires `ASANA_DEFAULT_PROJECT_GID`. PR'd tasks are marked actioned and not re-implemented until they change; see [Tickets already actioned after a PR](./worker.md#tickets-already-actioned-after-a-pr).
- For instant pickup, run `devintern worker connect asana` to register a project webhook through the [relay](./relay.md).

## Troubleshooting

| Symptom                                         | Fix                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `Missing required Asana environment variables`  | Set `ASANA_API_TOKEN`.                                                            |
| `Cannot resolve a project for task`             | Add the task to a project or set `ASANA_DEFAULT_PROJECT_GID`.                      |
| `Section "In Progress" not found in the project` | Fix the section name; the error lists available sections.                        |
| `Asana task search requires a project`          | Pass `project:<gid>` in the query or set `ASANA_DEFAULT_PROJECT_GID`.              |
| Comment formatting lost                         | Rich text Asana rejects is posted as plain text instead.                           |
