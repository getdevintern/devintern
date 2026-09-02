---
title: "Implement Linear Issues with @devintern/code"
sidebarLabel: "Linear Integration"
description: "Fetch Linear issues, move workflow states, implement with your coding agent, and open PRs with summaries posted back."
section: "Code"
order: 5
sidebarHidden: true
dateModified: 2026-08-17
tags: ["linear", "devintern/code", "integration"]
---

# Implement Linear Issues with @devintern/code

@devintern/code can implement work directly from Linear issues: fetch issue details and comments, run a feasibility check, move the issue through your workflow states, execute your AI agent, commit changes, open a pull request, and post results back to the issue.

## Prerequisites

- [Bun](https://bun.sh) and `@getdevintern/code` installed globally
- Linear Personal API key
- Git repository for your project

## Setup

### 1. Set the task tracker

In `.devintern-code/.env`:

```bash
TASK_TRACKER=linear
```

### 2. Add your Linear API key

```bash
LINEAR_API_KEY=lin_api_xxxxxxxxxxxx
```

Create the key at [Linear API settings](https://linear.app/settings/api): under **Personal API keys**, click **Create key**, add a label (e.g. `DevIntern`), and copy the key. It starts with `lin_api_` and cannot be viewed again after you leave the page. The key inherits your Linear account permissions.

### 3. Configure workflow state transitions

Edit `.devintern-code/settings.json` using the team key (the prefix in identifiers like `ENG-42`) as the project key:

```json
{
  "linear": {
    "projects": {
      "ENG": {
        "inProgressStatus": "In Progress",
        "todoStatus": "Backlog",
        "prStatus": "In Review"
      }
    }
  }
}
```

State names must match your team's workflow states (case-insensitive). @devintern/code moves issues to:

- **inProgressStatus** when implementation starts (after the clarity check)
- **prStatus** after a pull request is created
- **todoStatus** when implementation is incomplete or max turns are reached

See [Configuration](./configuration.md) for all settings fields.

## Running an issue

Pass one or more issue identifiers or full issue URLs. Identifiers are case-insensitive (`dan-6` is the same as `DAN-6`). Multiple keys are processed in order:

```bash
# Identifier
devintern ENG-42 --create-pr

# Several issues in one run
devintern dan-6 dan-7 dan-8 --create-pr

# Full issue URL
devintern https://linear.app/acme/issue/ENG-42/fix-login-bug --create-pr
```

This workflow:

1. Fetches the issue description, labels, attachments, and comments
2. Runs a feasibility assessment (skippable with `--skip-clarity-check`)
3. Moves the issue to `inProgressStatus` (unless `--skip-comments` is set)
4. Creates a feature branch, runs your agent, commits, and optionally opens a PR
5. Moves the issue to `prStatus` after PR creation
6. Posts implementation or assessment comments on the issue

## Batch processing with --query

Select multiple issues with a [Linear IssueFilter](https://studio.linear.app/graphql) expressed as JSON:

```bash
devintern --query '{"state":{"name":{"eq":"Todo"}},"team":{"key":{"eq":"ENG"}}}' --create-pr
```

Plain text works too and matches against issue titles (case-insensitive contains):

```bash
devintern --query "login bug" --create-pr
```

The first 50 matching issues are processed in sequence.

## Story points estimation

Linear has a native estimate field, so estimation mode is fully supported:

```bash
devintern ENG-42 --estimate
```

This analyzes the issue, sets the native estimate value, and posts (or updates) an estimation comment with reasoning, risks, and unclear areas.

## Limitations

- **Attachments:** files hosted on `uploads.linear.app` are downloaded with your API key. External attachment links (Figma, Google Docs) are passed to the agent as links.
- **Comments:** use `--skip-comments` to skip Linear comments and state transitions for a run.

## Troubleshooting

**"Missing required Linear environment variables"**

Ensure `LINEAR_API_KEY` is set in `.devintern-code/.env`.

**Issue does not move between states**

Confirm the state names in `settings.json` match your team's workflow states, and that the project key is the team key from the issue identifier (`ENG` for `ENG-42`).

**"Workflow state \"In Progress\" not found for team"**

Check spelling against your team's workflow states in Linear settings. Available states are shown in the error message.

**"Invalid Linear IssueFilter JSON"**

Quote the JSON filter in single quotes in your shell and validate it against the IssueFilter schema in the [Linear GraphQL explorer](https://studio.linear.app/graphql).
