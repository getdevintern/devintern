---
title: "GitLab integration for @devintern/code"
sidebarLabel: "GitLab Integration"
description: "Implement GitLab issues and experimentally create merge requests on GitLab.com or GitLab Self-Managed."
section: "Code"
order: 6
sidebarHidden: true
dateModified: 2026-09-09
tags: ["gitlab", "gitlab-self-hosted", "devintern/code", "integration"]
---

# GitLab integration for @devintern/code

@devintern/code can implement work directly from GitLab issues: fetch issue details and comments, run a feasibility check, move status labels, execute your AI agent, commit changes, and post results back on the issue. Both **GitLab Cloud** and **self-hosted instances** are supported.

GitLab can also be used independently as the code host. Experimental code-host support creates merge requests on GitLab.com or one configured GitLab Self-Managed instance. Your task may come from any supported tracker; the origin Git remote determines where the pull or merge request is created.

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
4. Creates a feature branch, runs your agent, commits, and optionally opens a pull or merge request
5. Applies the `prStatus` label after PR creation
6. Posts implementation or assessment comments on the issue

## Experimental merge-request creation

This first code-host release creates and records merge requests. GitLab review polling, `address-review`, conflict repair, CI repair, broad `@mention` discovery, and GitLab webhooks are not enabled yet.

Add a separate code-host profile to `.devintern-code/.env`:

```bash
DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST=true

# Omit for GitLab.com. For Self-Managed, use the instance root, including any
# relative installation path.
GITLAB_CODE_HOST_URL=https://gitlab.example.com

# Personal, project, or group access token with API access.
GITLAB_CODE_HOST_TOKEN=glpat_xxxxxxxxxxxx
```

Then run the existing compatible command:

```bash
devintern PROJ-123 --create-pr
devintern PROJ-123 --create-pr --pr-target-branch develop
```

`--create-pr` remains the stable cross-provider flag. On a detected GitLab remote it opens a merge request and reports GitLab-native terminology in the result.

The GitLab task tracker and code-host credentials are deliberately independent. `GITLAB_TOKEN` is reused only when `TASK_TRACKER=gitlab` and `GITLAB_BASE_URL` exactly matches the code-host instance. A token is never forwarded to a different host.

### Self-Managed remotes

HTTPS, normal SSH URLs, SCP-style SSH URLs, subgroups, custom ports, and relative installation paths are supported. If SSH config uses a hostname alias that differs from the browser URL, list it explicitly:

```bash
GITLAB_CODE_HOST_URL=https://gitlab.corp.example/platform
GITLAB_CODE_HOST_ALIASES=corp-git,gitlab-vpn
```

DevIntern recognizes `gitlab.com`, the configured instance host, and these explicit aliases. It does not probe or guess unknown hosts.

For an internal certificate authority, provide a readable PEM bundle. Do not disable TLS verification:

```bash
GITLAB_CODE_HOST_CA_FILE=/etc/company/gitlab-ca.pem
```

Bun honors standard `HTTP_PROXY` and `HTTPS_PROXY` variables. An integration-specific proxy can override them:

```bash
GITLAB_CODE_HOST_PROXY=http://proxy.corp.example:8080
```

### Creation behavior

- An explicit `--pr-target-branch` is authoritative; otherwise DevIntern uses the repository default branch.
- Source and target branches are checked through the GitLab API before creation.
- Duplicate recovery requires the same instance, source project and branch, and target project and branch.
- `PR_LABELS` remains supported. Only labels already present in the GitLab project are applied; missing labels produce a warning and are not created.
- MR creation failure retains the existing nonfatal PR behavior: the pushed branch remains available and the task run reports the failure.
- Created MRs are stored with provider, instance, numeric project ID, project path, IID, and canonical URL. The dashboard displays the stored URL.

### Current capability matrix

| Capability | GitLab status |
| --- | --- |
| GitLab.com MR creation | Experimental |
| Latest stable GitLab Self-Managed MR creation | Experimental |
| Personal, project, and group access tokens | Supported for API access |
| Existing labels | Best-effort; missing labels are skipped |
| Manual `address-review` | Deferred |
| Registered-MR polling | Deferred |
| Conflict and CI repair | Deferred |
| Direct project webhooks | Deferred |
| Repository-wide mentions and hosted relay | Not currently planned |

The validated Self-Managed target is the latest stable GitLab release at the time @devintern/code ships. Other REST API v4 versions continue best-effort with a compatibility warning.

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
- **Merge-request automation:** the experimental release creates MRs only. Review, CI, conflict, mention, and webhook automation remain disabled until their provider-specific phases ship.

## Troubleshooting

**"Missing required GitLab credentials"**

Ensure `GITLAB_TOKEN` and `GITLAB_PROJECT` are set in `.devintern-code/.env`.

**"GitLab API error (401)"**

Token rejected: check that it was created on the same instance as `GITLAB_BASE_URL`, has not expired, and carries the `api` scope.

**"Label \"In Progress\" not found in the project"**

Create the label in your project (Issues → Labels) or change the status names in `settings.json` to match existing labels.

**Old status labels pile up on issues**

Set `GITLAB_STATUS_LABELS` to the full list of status label names so transitions remove the previous status.
