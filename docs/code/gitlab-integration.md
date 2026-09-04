---
title: "Implement GitLab Issues with @devintern/code"
sidebarLabel: "GitLab Integration"
description: "Fetch GitLab issues (cloud or self-hosted), track status labels, implement with your coding agent, and post results back."
section: "Code"
order: 6
sidebarHidden: true
dateModified: 2026-08-24
tags: ["gitlab", "gitlab-self-hosted", "devintern/code", "integration"]
---

# Implement GitLab Issues with @devintern/code

@devintern/code can implement work directly from GitLab issues: fetch issue details and comments, run a feasibility check, move status labels, execute your AI agent, commit changes, and post results back on the issue. Both **GitLab Cloud** and **self-hosted instances** are supported.

## Prerequisites

- [Bun](https://bun.sh) and `@getdevintern/code` installed globally
- GitLab personal access token with the `api` scope
- Git repository for your project

## Setup

### 1. Set the task tracker

In `.devintern-code/.env`:

```bash
TASK_TRACKER=gitlab
```

### 2. Add GitLab credentials

```bash
# Cloud default — omit for gitlab.com; set for self-hosted:
GITLAB_BASE_URL=https://gitlab.example.com

GITLAB_TOKEN=glpat_xxxxxxxxxxxx
GITLAB_PROJECT=group/sub/repo
```

- `GITLAB_BASE_URL` — instance root URL. Omit for GitLab Cloud (`https://gitlab.com` is the default). Self-hosted instances keep their protocol, so internal `http://` hosts work.
- `GITLAB_TOKEN` — personal access token from `/-/user_settings/personal_access_tokens` on the same instance, with the **`api`** scope.
- `GITLAB_PROJECT` — project path (`group/repo`, subgroups allowed: `group/sub/repo`) or a numeric project ID.

### 3. Configure status labels

Like GitHub Issues, GitLab has no built-in workflow states that map cleanly across teams, so @devintern/code maps statuses to labels. Create the labels in your project, then configure them in `.devintern-code/settings.json` using the project path as the key:

```json
{
  "gitlab": {
    "projects": {
      "acme/team/webapp": {
        "inProgressStatus": "In Progress",
        "todoStatus": "To Do",
        "prStatus": "In Review"
      }
    }
  }
}
```

To keep statuses mutually exclusive, also list them in `.devintern-code/.env`:

```bash
GITLAB_STATUS_LABELS=To Do,In Progress,In Review
```

When a status changes, @devintern/code adds the target label and removes the other labels in this list. Transitioning to `closed` or `done` closes the issue instead of applying a label; moving back to an open status reopens it.

## Running an issue

Pass an issue number, `#number`, a `group/sub/repo#123` reference, or a full issue URL:

```bash
# Issue number
devintern 123 --create-pr

# Full issue URL (self-hosted URLs work too)
devintern https://gitlab.com/acme/team/webapp/-/issues/123 --create-pr
```

This workflow:

1. Fetches the issue body, labels, and comments
2. Runs a feasibility assessment (skippable with `--skip-clarity-check`)
3. Applies the `inProgressStatus` label (unless `--skip-comments` is set)
4. Creates a feature branch, runs your agent, commits, and optionally opens a PR
5. Applies the `prStatus` label after PR creation
6. Posts implementation or assessment comments on the issue

## Batch processing with --query

Select multiple issues with familiar qualifiers — @devintern/code translates them to GitLab's [list issues](https://docs.gitlab.com/ee/api/issues.html#list-project-issues) filters. Queries are always scoped to `GITLAB_PROJECT`:

```bash
devintern --query "is:open label:bug" --create-pr
devintern --query 'is:open "login flow"' --create-pr
devintern --query "assignee:@me" --create-pr
```

Supported qualifiers: `is:open` / `is:closed`, `label:name` (repeatable), `assignee:@me` / `assignee:username`, `updated:>=<date>`. Anything else is free-text search.

The first 100 matching issues are processed in sequence.

## Story points estimation

GitLab issues have no estimation field, so `--estimate` runs in comment-only mode: the analysis is posted (or updated) as an issue comment with the suggested points, reasoning, risks, and unclear areas.

## Token scopes for Cloud vs. self-hosted

| Scope      | Needed for                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------ |
| `api`      | Full read/write access (recommended)                                                       |
| `read_api` | Read-only setups (fetching issues works; posting comments and label transitions will fail) |

Self-hosted tokens only exist on their own instance — a gitlab.com token cannot authenticate against your on-premises GitLab and vice versa.

## Limitations

- **Attachments:** files embedded in issue bodies (`/uploads/...` links) are downloaded for the agent using your token; other external links stay as references.
- **Status labels:** labels named in `settings.json` must already exist in the project. The error message lists available labels when one is missing.
- **Comments:** use `--skip-comments` to skip issue comments and label transitions for a run.
- **Pull requests:** PR creation targets GitHub/Bitbucket remotes today; GitLab merge-request automation is not part of this integration yet.

## Troubleshooting

**"Missing required GitLab credentials"**

Ensure `GITLAB_TOKEN` and `GITLAB_PROJECT` are set in `.devintern-code/.env`.

**"GitLab API error (401)"**

Token rejected: check that it was created on the same instance as `GITLAB_BASE_URL`, has not expired, and carries the `api` scope.

**"Label \"In Progress\" not found in the project"**

Create the label in your project (Issues → Labels) or change the status names in `settings.json` to match existing labels.

**Old status labels pile up on issues**

Set `GITLAB_STATUS_LABELS` to the full list of status label names so transitions remove the previous status.
