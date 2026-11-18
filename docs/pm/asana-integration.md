---
title: "Create Asana Tasks with DevIntern PM"
sidebarLabel: "Asana Integration"
description: "Create structured Asana tasks from AI drafts in the projects your team already uses."
section: "Create Tasks"
order: 7
dateModified: 2026-11-18
sidebarHidden: true
---

# Create Asana Tasks with DevIntern PM

DevIntern PM creates Asana tasks and subtasks from AI-drafted stories, with rich-text descriptions.

## Prerequisites

- An Asana account with at least one project you can add tasks to.

## Setup

Run `devpm init` and pick Asana, or set these in `.devintern-pm/.env`:

```bash
TASK_TRACKER=asana
ASANA_API_TOKEN=your-asana-pat
# ASANA_DEFAULT_PROJECT_GID=2222222222222222
```

| Variable                    | Required | Where to find it                                                                                                                                |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASANA_API_TOKEN`           | yes      | [Asana developer console](https://app.asana.com/0/developer-console) → new **Personal access token**.                                           |
| `ASANA_DEFAULT_PROJECT_GID` | no       | The number right after `/project/` in the project URL (not the workspace ID before it or the view ID after it). Defaults to your first project. |

```
https://app.asana.com/1/1111111111111111/project/2222222222222222/list/3333333333333333
                                              └─ project GID ─┘
```

## Usage

```bash
devpm --interactive
```

| devpm concept      | Asana object                  |
| ------------------ | ----------------------------- |
| Story / Task / Bug | Task in the target project    |
| Subtask            | Subtask under the parent task |
| Epic link          | Parent task                   |

Asana has no Jira-style issue types, so that step is skipped.

## Troubleshooting

**"Asana backend selected but ASANA_API_TOKEN is missing"**: create a token and set `ASANA_API_TOKEN`.

**"Asana API error (401)"**: the token is invalid, revoked, or has extra spaces.

**"Asana API error (403)"**: your account can't create tasks in that project, or the project is in a workspace the token can't access.

**Tasks land in the wrong project**: set `ASANA_DEFAULT_PROJECT_GID`, or pick the project in interactive mode.

**"Could not fetch projects"**: check the token and access to `app.asana.com`, and that your account has at least one project.
