---
title: "Implement Jira Issues with @devintern/code"
sidebarLabel: "Jira Integration"
description: "Fetch Jira Cloud issues, run the feasibility gate, implement with your coding agent, and post PRs and summaries back to the issue."
section: "Code"
order: 4
dateModified: 2026-07-23
tags: ["jira", "devintern/code", "integration", "jira cloud"]
---

# Implement Jira Issues with @devintern/code

@devintern/code implements work from Jira Cloud issues: fetch issue details, comments, and attachments, run a feasibility check, transition statuses, execute your AI agent, commit changes, open pull requests, and post results back to the issue.

This integration targets **Jira Cloud** (`*.atlassian.net`). Jira Data Center / Server is not supported.

## How It Works

@devintern/code uses the [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) to read and update issues you pass on the command line or select with JQL.

- Issue descriptions are converted from **Atlassian Document Format (ADF)** to markdown for your AI agent
- Comments from humans are included; prior @devintern/code comments are filtered out to reduce noise
- Attachments are downloaded into the task output directory when present
- Status transitions use workflow status **names** from your `settings.json` (for example, "In Progress", "In Review")
- After a run, feasibility, implementation, or incomplete summaries are posted as Jira comments

## Setup

### 1. Initialize project config

From your repository root:

```bash
devintern init
```

This creates `.devintern-code/.env` and `.devintern-code/settings.json`.

### 2. Set Jira credentials

In `.devintern-code/.env`:

```bash
TASK_TRACKER=jira
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-api-token
```

`TASK_TRACKER` defaults to `jira` if omitted. All three Jira variables are required.

### 3. Create an API token

1. Go to [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**, add a label (e.g. `DevIntern`), and copy the token
3. Paste the token into `JIRA_API_TOKEN`

Use the **email address** of the Atlassian account that owns the token for `JIRA_EMAIL`. Authentication is Basic auth (`email:token`).

Store credentials in `.devintern-code/.env`. That file should stay out of version control (`devintern init` adds it to `.gitignore`).

### 4. Find your Jira site URL

Your site URL is the hostname you use to open Jira in the browser:

```
https://your-org.atlassian.net/jira/...
        └─ JIRA_BASE_URL ─┘
```

Set `JIRA_BASE_URL` to the full URL **without** a trailing slash.

### 5. Configure status transitions (optional)

Edit `.devintern-code/settings.json` using the **project key** as the lookup key (the prefix in issue keys, e.g. `PROJ` in `PROJ-123`):

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

@devintern/code transitions issues to:

- **inProgressStatus** when implementation starts (after the clarity check)
- **prStatus** after a pull request is created
- **todoStatus** when implementation is incomplete or max turns are reached

Status names must match your Jira workflow exactly. Omit a field to skip that transition.

See [Configuration](./configuration.md) for legacy `projects` format and other settings.

## Running tasks

### Single issue

```bash
devintern PROJ-123
devintern PROJ-123 --create-pr
devintern PROJ-123 --skip-clarity-check --create-pr
```

### Multiple issues

```bash
devintern PROJ-123 PROJ-124 PROJ-125 --create-pr
```

### Batch with JQL

```bash
devintern --jql "project = PROJ AND status = 'To Do'" --create-pr

devintern --query "assignee = currentUser() AND status = 'To Do'" --create-pr
```

`--query` is the preferred flag; `--jql` remains available with a deprecation warning.

### Story points estimation

Batch mode for AI-assisted estimation (also available for Linear):

```bash
devintern PROJ-123 --estimate
devintern --estimate --query "project = PROJ AND status = 'To Do'"
```

See [Story Points Estimation](./story-points-estimation.md) for field discovery, re-estimation, and automation examples.

## What Gets Posted

| Stage                     | Jira comment                                             |
| ------------------------- | -------------------------------------------------------- |
| Feasibility check         | Automated Task Feasibility Assessment (markdown summary) |
| Successful implementation | Implementation Completed by @devintern/code              |
| Incomplete / max turns    | Implementation Incomplete                                |
| Estimation (`--estimate`) | Automated Story Points Estimation                        |

Use `--skip-comments` to skip all Jira comments and status transitions for a run.

## Permissions

Your Jira user needs, at minimum:

- **Browse projects** and **View issues** on target projects
- **Transition issues** if you configure status changes
- **Add comments** unless you use `--skip-comments`
- **Edit issues** for story points when using `--estimate`

## Troubleshooting

**"Missing required JIRA environment variables"**

Set `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` in `.devintern-code/.env`.

**"Issue not found"**

- Verify the issue key exists and you have access
- Confirm `JIRA_BASE_URL` matches your Cloud site
- Check that `JIRA_EMAIL` matches the account that created the API token

**Jira API error (401)**

- API token is invalid or revoked. Create a new token at [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
- `JIRA_EMAIL` does not match the token owner

**Jira API error (403)**

- Your account lacks permission on the issue or project
- Ask a Jira admin to grant browse, comment, or transition permissions

**Status transition failed**

- The status name in `settings.json` does not match your workflow (check spelling and capitalization)
- The transition may not be valid from the issue's current status
- @devintern/code logs a warning and continues the run when a transition fails

**JQL returns no issues**

- Test the query in Jira's issue search first
- Quote project names and statuses that contain spaces: `project = "My Project"`

**Descriptions look wrong in agent context**

@devintern/code converts ADF to markdown. Unusual ADF structures may lose formatting; simplify the issue description in Jira if needed.
