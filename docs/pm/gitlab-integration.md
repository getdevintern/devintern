---
title: "Create GitLab Issues with @devintern/pm"
sidebarLabel: "GitLab Integration"
description: "File well-specified GitLab issues from AI drafts on gitlab.com or a self-hosted instance."
section: "PM"
order: 7
---

# Create GitLab Issues with @devintern/pm

@devintern/pm creates GitLab issues directly from AI-generated stories and tasks. Setup takes a few minutes: you need a Personal Access Token and a target project. Both **GitLab Cloud (gitlab.com)** and **self-hosted instances** are supported.

## How It Works

@devintern/pm uses the [GitLab REST API v4](https://docs.gitlab.com/ee/api/issues.html) to create and update issues in a project you configure.

- New issues appear under the project's **Issues** tab
- Stories, bugs, tasks, and epics map to issue labels (see below)
- Subtasks become linked issues with a task list on the parent issue
- Epic linking is not supported: project issues have no native parent hierarchy, so the epic linking step is skipped in interactive mode and the `--epic` flag is ignored

## Cloud vs. Self-Hosted

| Flavor | `GITLAB_BASE_URL` | Notes |
| --------------------- | ------------------------- | ----------------------------------------------- |
| GitLab Cloud          | omit (default `https://gitlab.com`) | Works out of the box |
| Self-managed instance | e.g. `https://gitlab.example.com`   | Protocol is kept; `http://` internal hosts work |

## Setup

### 1. Set the backend

In your `.devintern-pm/.env`:

```bash
TASK_TRACKER=gitlab

# Cloud (default) — omit or leave commented:
# GITLAB_BASE_URL=https://gitlab.com

# Self-hosted — set your instance root URL:
GITLAB_BASE_URL=https://gitlab.example.com
```

`GITLAB_BASE_URL` is the instance root, without `/api/v4`.

### 2. Create a Personal Access Token

1. Sign in to your GitLab instance
2. Go to **User Settings → Access Tokens** (`/-/user_settings/personal_access_tokens`)
3. Create a token with the **`api`** scope (read + write). A read-only setup needs `read_api`, but @devintern/pm creates and updates issues, so `api` is required.
4. Copy the token (tokens starting `glpat-…` cannot be viewed again after creation)

Project access tokens and group access tokens also work if they include the `api` scope and at least **Reporter** role on the target project.

### 3. Configure the target project

```bash
GITLAB_TOKEN=glpat_xxxxxxxxxxxx
GITLAB_PROJECT=group/repo
```

`GITLAB_PROJECT` accepts:

- A project path: `group/repo` or with subgroups `group/sub/repo`
- A numeric project ID (visible under the project name on the project overview)

Run `devpm --interactive` to create your first issue.

## Issue Types and Labels

When you pick an issue type in @devintern/pm, it applies a GitLab label:

| devpm issue type | GitLab label  |
| ---------------- | ------------- |
| Story            | `enhancement` |
| Bug              | `bug`         |
| Task             | `task`        |
| Epic             | `epic`        |

New projects do not include all of these labels by default. Create them under **Issues → Labels** in your project, or issue creation may fail when applying a missing label.

## What Gets Created

| devpm concept             | GitLab object                                                 |
| ------------------------- | ------------------------------------------------------------- |
| Story / Bug / Task / Epic | Issue with title, description, and mapped label               |
| Subtask                   | New issue linked from a `## Subtasks` task list on the parent |
| Epic link                 | Not supported (step is skipped)                               |

## Troubleshooting

**"Missing required environment variables"**

Set both `GITLAB_TOKEN` and `GITLAB_PROJECT` in `.devintern-pm/.env`. `GITLAB_BASE_URL` is optional for gitlab.com but required for self-hosted instances.

**"GitLab API error (401)"**

- Token is invalid or expired: generate a new one
- On self-hosted instances, confirm the token was created on the same instance as `GITLAB_BASE_URL`

**"GitLab API error (403)"**

- Token lacks the `api` scope
- Your account lacks permission to create issues in that project (need at least Reporter)

**"Invalid GITLAB_PROJECT"**

Use `group/repo` (subgroups allowed) or a numeric project ID — not the human-readable project name alone.

**Self-signed certificates**

The integration talks to your instance's normal HTTPS endpoint. Instances behind self-signed TLS need the certificate trusted at the OS level where @devintern/pm runs.
