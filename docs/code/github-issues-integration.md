---
title: "Implement GitHub Issues with DevIntern Code"
sidebarLabel: "GitHub Issues Integration"
description: "Fetch GitHub issues, track status labels, implement with your coding agent, and open the PR in the same repository."
section: "Automation"
order: 5
sidebarHidden: true
dateModified: 2026-11-18
tags: ["github", "github-issues", "devintern/code", "integration"]
---

# Implement GitHub Issues with DevIntern Code

DevIntern Code reads a GitHub issue (body, labels, comments, embedded files), checks that it is clear enough to implement, tracks progress with status labels, runs your coding agent, opens a pull request in the same repository, and posts the result back on the issue.

For PR review automation, use the [worker](./worker.md) with the [relay](./relay.md). Self-hosted webhooks are an advanced alternative: [GitHub Webhooks and PR Automation](./github-integration.md).

## Prerequisites

- `@getdevintern/code` installed and a Git repository for your project
- A GitHub token: classic with `repo` scope, or fine-grained with **Issues** and **Pull requests** read/write

## Setup

Set in `.devintern-code/.env`:

| Variable               | Required | Description                                                                         |
| ---------------------- | -------- | ----------------------------------------------------------------------------------- |
| `TASK_TRACKER`         | Yes      | `github`                                                                            |
| `GITHUB_TOKEN`         | Yes      | Personal access token (the same one used for PR creation)                            |
| `GITHUB_REPO`          | Yes      | Repository whose issues you implement, as `owner/repo`                              |
| `GITHUB_STATUS_LABELS` | No       | Comma-separated status labels (e.g. `To Do,In Progress,In Review`); on each transition the others are removed |

GitHub App credentials (`GITHUB_APP_ID` + private key) cannot replace `GITHUB_TOKEN` for this tracker. See [GitHub authentication](./configuration.md#github-authentication).

## Run a task

Pass an issue number, `#number`, or full URL:

```bash
devintern 123 --create-pr
devintern https://github.com/acme/webapp/issues/123 --create-pr
```

Batch runs use [GitHub search qualifiers](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests), automatically scoped with `repo:owner/repo is:issue` (if you add your own `repo:`, add `is:issue` too). The first 100 matches run in sequence; GitHub search is limited to 30 requests per minute.

```bash
devintern --query "is:open label:bug" --create-pr
```

Use `--skip-clarity-check` to skip the feasibility check and `--skip-comments` to skip comments and label changes. `--estimate` posts a comment only (GitHub has no estimate field); see [Story Points Estimation](./story-points-estimation.md).

## Status mapping

GitHub has no workflow states, so statuses map to labels. Create the labels in the repository, then configure them in `.devintern-code/settings.json`, keyed by `owner/repo`. A status of `closed` or `done` closes the issue instead.

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

| Field              | When it is applied                                   |
| ------------------ | ---------------------------------------------------- |
| `inProgressStatus` | Implementation starts (after the feasibility check)  |
| `prStatus`         | A pull request is created                            |
| `todoStatus`       | The run is incomplete, fails, or hits the turn limit |

## Worker notes

- A typical worker query is `is:open label:intern`. Label transitions do not remove your trigger label, so the worker's local actioned marker is what stops a PR'd issue from being re-implemented. See [Tickets already actioned after a PR](./worker-troubleshooting.md#tickets-already-actioned-after-a-pr).
- `devintern worker connect github` pairs the repository with the relay for instant PR events.

## Troubleshooting

| Symptom                                          | Fix                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `Missing required GitHub environment variables`  | Set `GITHUB_TOKEN` and `GITHUB_REPO`. An App ID and key are not enough.                  |
| `Label "In Progress" not found in the repository` | Create the label (Issues → Labels) or change the names in `settings.json`; the error lists existing labels. |
| Old status labels pile up                        | Set `GITHUB_STATUS_LABELS` to the full list of status labels.                            |
