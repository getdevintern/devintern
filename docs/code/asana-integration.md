---
title: "Implement Asana Tasks with @devintern/code"
sidebarLabel: "Asana Integration"
description: "Fetch Asana tasks, move project sections, implement with your coding agent, and post results back as comments."
section: "Code"
order: 5
dateModified: 2026-07-23
tags: ["asana", "devintern/code", "integration"]
---

# Implement Asana Tasks with @devintern/code

@devintern/code can implement work directly from Asana tasks: fetch task details and comments, run a feasibility check, move the task between project sections, execute your AI agent, commit changes, open a pull request, and post results back as task comments.

## Prerequisites

- [Bun](https://bun.sh) and `@getdevintern/code` installed globally
- Asana personal access token
- Git repository for your project

## Setup

### 1. Set the task tracker

In `.devintern-code/.env`:

```bash
TASK_TRACKER=asana
```

### 2. Add Asana credentials

```bash
ASANA_API_TOKEN=your-asana-pat
ASANA_DEFAULT_PROJECT_GID=1200000000000000
```

Create the personal access token in [Asana developer settings](https://app.asana.com/0/my-apps). `ASANA_DEFAULT_PROJECT_GID` is optional but recommended: it anchors section transitions and batch queries to a specific project. Find the GID in the project URL.

### 3. Configure section transitions

Asana has no global workflow states, so @devintern/code maps statuses to project sections. Configure them in `.devintern-code/settings.json` using the project GID as the project key:

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

Section names must match your project's sections (case-insensitive). Transitioning to `done`, `completed`, or `closed` marks the task complete instead of moving sections.

## Running a task

Pass a task GID or a full task URL:

```bash
# Task GID
devintern 1200000000000001 --create-pr

# Full task URL
devintern https://app.asana.com/0/1200000000000000/1200000000000001 --create-pr
```

This workflow:

1. Fetches the task notes, tags, attachments, and comments
2. Runs a feasibility assessment (skippable with `--skip-clarity-check`)
3. Moves the task to the `inProgressStatus` section (unless `--skip-comments` is set)
4. Creates a feature branch, runs your agent, commits, and optionally opens a PR
5. Moves the task to the `prStatus` section after PR creation
6. Posts implementation or assessment comments on the task

## Batch processing with --query

Asana has no query language, so @devintern/code provides a small filter syntax:

```bash
devintern --query 'section:"To Do" completed:false' --create-pr
devintern --query 'project:1200000000000000 assignee:Ada login bug' --create-pr
```

Supported filters: `project:<gid>` (defaults to `ASANA_DEFAULT_PROJECT_GID`), `section:"<name>"`, `assignee:<name>`, `completed:true|false`. Any remaining text matches task names (case-insensitive).

The integration lists the project's tasks (first 100) and filters them locally, which keeps it working on free Asana plans (the workspace search API requires Premium).

## Story points estimation

Asana has no built-in estimation field. If your project has a numeric custom field for points, name it in `.devintern-code/.env`:

```bash
ASANA_STORY_POINTS_FIELD=Story Points
```

With the field configured, `devintern <gid> --estimate` sets the custom field value and posts an estimation comment. Without it, estimates are posted as comments only.

## Limitations

- **Batch size:** queries read the first 100 tasks of a project. Narrow with sections for larger projects.
- **Rich text:** comments are posted as Asana rich text with a plain-text fallback when formatting is rejected.
- **Comments:** use `--skip-comments` to skip task comments and section moves for a run.

## Troubleshooting

**"Missing required Asana environment variables"**

Ensure `ASANA_API_TOKEN` is set in `.devintern-code/.env`.

**"Cannot resolve a project for task"**

The task is not in any project and no `ASANA_DEFAULT_PROJECT_GID` is set. Add the task to a project or set the default project GID.

**"Section \"In Progress\" not found in the project"**

Check the section names in your project against `settings.json`. Available sections are listed in the error message.

**"Asana task search requires a project"**

Pass `project:<gid>` in the query or set `ASANA_DEFAULT_PROJECT_GID`.
