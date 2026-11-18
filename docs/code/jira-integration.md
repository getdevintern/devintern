---
title: "Implement Jira Issues with DevIntern Code"
sidebarLabel: "Jira Integration"
description: "Fetch Jira Cloud issues, run the feasibility gate, implement with your coding agent, and post PRs and summaries back to the issue."
section: "Automation"
order: 4
sidebarHidden: true
dateModified: 2026-11-18
tags: ["jira", "devintern/code", "integration", "jira cloud"]
---

# Implement Jira Issues with DevIntern Code

DevIntern Code reads a Jira issue (description, human comments, attachments), checks that it is clear enough to implement, runs your coding agent, opens a pull request, and posts the result back as a Jira comment. It supports **Jira Cloud** (`*.atlassian.net`) only; Jira Data Center / Server is not supported.

## Prerequisites

- `@getdevintern/code` installed and a Git repository for your project
- A Jira Cloud account with an [API token](https://id.atlassian.com/manage-profile/security/api-tokens)
- Jira permissions: **Browse projects**, **Add comments** (unless you use `--skip-comments`), **Transition issues** (for status changes), **Edit issues** (for `--estimate`)

## Setup

Run `devintern init` in the repository root, then set these in `.devintern-code/.env` (kept out of Git by `devintern init`):

| Variable                   | Required | Description                                                                                  |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `TASK_TRACKER`             | No       | `jira` (the default when unset)                                                              |
| `JIRA_BASE_URL`            | Yes      | Your site URL without a trailing slash, e.g. `https://your-org.atlassian.net`                |
| `JIRA_EMAIL`               | Yes      | Email of the Atlassian account that owns the API token                                       |
| `JIRA_API_TOKEN`           | Yes      | API token from [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_DEFAULT_PROJECT_KEY` | No       | Default project key (e.g. `PROJ`); `devintern worker init` uses it to seed a routing rule     |

## Run a task

```bash
devintern PROJ-123 --create-pr
devintern PROJ-123 PROJ-124 --create-pr                       # several issues in order
devintern --query "project = PROJ AND status = 'To Do'" --create-pr   # JQL batch
```

`--jql` is a deprecated alias for `--query`. Use `--skip-clarity-check` to skip the feasibility check and `--skip-comments` to skip all comments and status transitions for a run.

DevIntern posts a comment for the feasibility assessment, a completed or incomplete implementation, and story-point estimates. For AI estimation (`--estimate`, `storyPointsField`), see [Story Points Estimation](./story-points-estimation.md).

## Status mapping

Configure transitions in `.devintern-code/settings.json`, keyed by the project key (`PROJ` in `PROJ-123`). Status names must match your workflow exactly; omit a field to skip that transition.

```json
{
  "jira": {
    "projects": {
      "PROJ": {
        "inProgressStatus": "In Progress",
        "todoStatus": "To Do",
        "prStatus": "In Review",
        "storyPointsField": "customfield_10016"
      }
    }
  }
}
```

| Field              | When it is applied                                     |
| ------------------ | ------------------------------------------------------ |
| `inProgressStatus` | Implementation starts (after the feasibility check)    |
| `prStatus`         | A pull request is created                              |
| `todoStatus`       | The run is incomplete, fails, or hits the turn limit   |

The legacy top-level `projects` key (without `jira`) still works.

## Worker notes

- The [worker](./worker.md#polling-mode) uses your JQL as `[defaults].task_query`. Moving issues to `prStatus` removes them from a `status = 'To Do'` query; the worker also marks PR'd issues as actioned so they are not re-implemented. See [Tickets already actioned after a PR](./worker.md#tickets-already-actioned-after-a-pr).
- For instant pickup, run `devintern worker connect jira` and paste the printed ingest URL into a Jira admin webhook. See [Relay](./relay.md).

## Troubleshooting

| Symptom                                      | Fix                                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Missing required JIRA environment variables` | Set `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` in `.devintern-code/.env`.                                    |
| `Issue not found`                            | Check the key, that `JIRA_BASE_URL` is your Cloud site, and that `JIRA_EMAIL` owns the token.                         |
| 401 error                                    | The token is invalid or revoked, or `JIRA_EMAIL` is not the token owner. Create a new token.                          |
| 403 error                                    | Your account lacks permission on the project; ask a Jira admin for browse, comment, or transition rights.            |
| Status transition failed (warning)           | The name in `settings.json` does not match your workflow, or the transition is not allowed from the current status. The run continues. |
| JQL returns no issues                        | Test the query in Jira's issue search; quote values with spaces (`project = "My Project"`).                           |
| Description formatting looks wrong           | Jira's rich text (ADF) is converted to Markdown; simplify unusual formatting in the issue.                            |
