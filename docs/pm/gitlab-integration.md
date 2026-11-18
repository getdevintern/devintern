---
title: "Create GitLab Issues with DevIntern PM"
sidebarLabel: "GitLab Integration"
description: "File well-specified GitLab issues from AI drafts on gitlab.com or a self-hosted instance."
section: "Create Tasks"
order: 7
dateModified: 2026-11-18
sidebarHidden: true
---

# Create GitLab Issues with DevIntern PM

DevIntern PM creates GitLab issues from AI-drafted stories on **gitlab.com** or a **self-hosted** instance.

## Prerequisites

- At least **Reporter** role on the target project.
- The labels you plan to use (see [Usage](#usage)). New projects don't include all of them.
- Self-hosted instances with a self-signed certificate: trust it at the OS level where devpm runs.

## Setup

Run `devpm init` and pick GitLab, or set these in `.devintern-pm/.env`:

```bash
TASK_TRACKER=gitlab
GITLAB_TOKEN=glpat-xxxxxxxxxxxx
GITLAB_PROJECT=group/repo
# GITLAB_BASE_URL=https://gitlab.example.com   # self-hosted only
```

| Variable          | Required        | Where to find it                                                                                                                                                         |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITLAB_TOKEN`    | yes             | **User Settings → Access Tokens** with the **`api`** scope (`read_api` is not enough). Project or group access tokens with `api` and Reporter also work. Shown only once. |
| `GITLAB_PROJECT`  | yes             | Project path (`group/repo`, subgroups allowed) or numeric project ID from the project overview.                                                                           |
| `GITLAB_BASE_URL` | self-hosted only | Instance root URL without `/api/v4`. Defaults to `https://gitlab.com`; `http://` internal hosts work.                                                                    |

## Usage

```bash
devpm --interactive
```

| devpm issue type | GitLab label  |
| ---------------- | ------------- |
| Story            | `enhancement` |
| Bug              | `bug`         |
| Task             | `task`        |
| Epic             | `epic`        |

Subtasks become separate issues linked from a `## Subtasks` task list on the parent. Project issues have no parent hierarchy, so epic linking is skipped and `--epic` is ignored. File attachments stay draft context only.

## Troubleshooting

**"Missing required environment variables"**: set `GITLAB_TOKEN` and `GITLAB_PROJECT`, plus `GITLAB_BASE_URL` for self-hosted.

**"GitLab API error (401)"**: the token is invalid or expired, or was created on a different instance than `GITLAB_BASE_URL`.

**"GitLab API error (403)"**: the token lacks the `api` scope, or you're below Reporter on the project.

**"Invalid GITLAB_PROJECT"**: use `group/repo` or a numeric ID, not the display name.

**Issue creation fails on a label**: create the missing label under **Issues → Labels**.
