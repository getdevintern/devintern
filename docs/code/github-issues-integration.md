---
title: "Implement GitHub Issues with @devintern/code"
sidebarLabel: "GitHub Issues Integration"
description: "Fetch GitHub issues, track status labels, implement with your coding agent, and open the PR in the same repository."
section: "Code"
order: 5
dateModified: 2026-07-23
tags: ["github", "github-issues", "devintern/code", "integration"]
---

# Implement GitHub Issues with @devintern/code

@devintern/code can implement work directly from GitHub Issues: fetch issue details and comments, run a feasibility check, move status labels, execute your AI agent, commit changes, open a pull request in the same repository, and post results back on the issue.

Looking for webhook-based PR review automation? See the [GitHub webhook server guide](./github-integration.md).

## Prerequisites

- [Bun](https://bun.sh) and `@getdevintern/code` installed globally
- GitHub personal access token
- Git repository for your project

## Setup

### 1. Set the task tracker

In `.devintern-code/.env`:

```bash
TASK_TRACKER=github
```

### 2. Add GitHub credentials

```bash
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_REPO=owner/repo
```

The same `GITHUB_TOKEN` used for pull request creation works here. It needs the `repo` scope (classic token) or `Issues: Read and write` plus `Pull requests: Read and write` (fine-grained token). `GITHUB_REPO` is the repository whose issues you want to implement, in `owner/repo` form.

### 3. Configure status labels

GitHub has no built-in workflow states, so @devintern/code maps statuses to labels. Create the labels in your repository, then configure them in `.devintern-code/settings.json` using `owner/repo` as the project key:

```json
{
  "github": {
    "projects": {
      "acme/webapp": {
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
GITHUB_STATUS_LABELS=To Do,In Progress,In Review
```

When a status changes, @devintern/code adds the target label and removes the other labels in this list. Transitioning to `closed` or `done` closes the issue instead of applying a label.

## Running an issue

Pass an issue number, `#number`, or a full issue URL:

```bash
# Issue number
devintern 123 --create-pr

# Full issue URL
devintern https://github.com/acme/webapp/issues/123 --create-pr
```

This workflow:

1. Fetches the issue body, labels, and comments
2. Runs a feasibility assessment (skippable with `--skip-clarity-check`)
3. Applies the `inProgressStatus` label (unless `--skip-comments` is set)
4. Creates a feature branch, runs your agent, commits, and optionally opens a PR
5. Applies the `prStatus` label after PR creation
6. Posts implementation or assessment comments on the issue

## Batch processing with --query

Select multiple issues with [GitHub search qualifiers](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests). The query is automatically scoped to your repository with `repo:owner/repo is:issue`:

```bash
devintern --query "is:open label:bug" --create-pr
devintern --query 'is:open "login flow"' --create-pr
```

The first 100 matching issues are processed in sequence. Note that GitHub's search API is rate-limited to 30 requests per minute.

## Story points estimation

GitHub Issues has no estimation field, so `--estimate` runs in comment-only mode: the analysis is posted (or updated) as an issue comment with the suggested points, reasoning, risks, and unclear areas.

## Limitations

- **Attachments:** GitHub has no attachment API. Images and files embedded in the issue body (`user-attachments` links) are downloaded for the agent.
- **Status labels:** labels named in `settings.json` must already exist in the repository. The error message lists available labels when one is missing.
- **Comments:** use `--skip-comments` to skip issue comments and label transitions for a run.

## Troubleshooting

**"Missing required GitHub environment variables"**

Ensure `GITHUB_TOKEN` and `GITHUB_REPO` are set in `.devintern-code/.env`.

**"Label \"In Progress\" not found in the repository"**

Create the label in your repository (Issues → Labels) or change the status names in `settings.json` to match existing labels.

**Old status labels pile up on issues**

Set `GITHUB_STATUS_LABELS` to the full list of status label names so transitions remove the previous status.

**Search returns pull requests**

Queries are scoped with `is:issue` automatically. If you pass your own `repo:` qualifier, include `is:issue` yourself.
