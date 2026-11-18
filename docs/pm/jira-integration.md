---
title: "Create Jira Issues with DevIntern PM"
sidebarLabel: "Jira Integration"
description: "Turn AI-drafted stories into Jira Cloud issues with ADF descriptions, subtasks, and epic links."
section: "Create Tasks"
order: 4
sidebarHidden: true
dateModified: 2026-11-18
tags: ["jira", "devintern/pm", "integration", "jira cloud"]
---

# Create Jira Issues with DevIntern PM

DevIntern PM creates Jira Cloud issues from AI-drafted stories, with formatted descriptions, subtasks, and epic links.

## Prerequisites

- A **Jira Cloud** site (`*.atlassian.net`). Jira Data Center / Server is not supported.
- Permission to create issues in the target project.

## Setup

Run `devpm init` and pick Jira, or set these in `.devintern-pm/.env`:

```bash
TASK_TRACKER=jira
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-api-token
JIRA_DEFAULT_PROJECT_KEY=PROJ
```

| Variable                   | Required | Where to find it                                                                                                     |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `JIRA_BASE_URL`            | yes      | The site URL you open Jira at, without a trailing slash.                                                             |
| `JIRA_EMAIL`               | yes      | Email of the Atlassian account that owns the API token.                                                              |
| `JIRA_API_TOKEN`           | yes      | [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) → **Create API token**.          |
| `JIRA_DEFAULT_PROJECT_KEY` | yes      | The prefix on issue keys (`PROJ` in `PROJ-123`), or **Project settings → Details → Key**.                            |

## Usage

```bash
devpm --interactive
```

| devpm concept             | Jira object                                          |
| ------------------------- | ---------------------------------------------------- |
| Story / Bug / Task / Epic | Issue of the selected type in the target project     |
| Subtask                   | Subtask issue linked to the parent                   |
| Epic link                 | Parent field set to the epic key (e.g. `PROJ-42`)    |

The issue type step lists the types configured in your project. Press `Ctrl+P` to create in a different project for this run; otherwise `JIRA_DEFAULT_PROJECT_KEY` is used.

## Troubleshooting

**"Jira backend selected but … configuration is missing"**: set all four `JIRA_*` variables.

**"Jira API error (401)"**: the token is invalid or revoked, has extra spaces, or `JIRA_EMAIL` is not the account that created it.

**"Jira API error (403)"**: your account lacks **Create issues** permission in the project. Ask a Jira admin.

**"Jira API error (400)"**: the issue type isn't available in this project (pick one from the interactive list), or the project key is wrong.

**Epic link fails**: use the epic's issue key (`PROJ-100`), not a numeric ID. devpm sets the **parent** field, which works with team-managed projects and modern company-managed epics, not legacy **Epic Link** custom fields.

**Descriptions lose formatting**: stick to standard Markdown (headings, lists, bold); unusual syntax may not convert to Jira's format.
