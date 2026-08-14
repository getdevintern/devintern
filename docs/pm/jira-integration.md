---
title: "Create Jira Issues with @devintern/pm"
sidebarLabel: "Jira Integration"
description: "Turn AI-drafted stories into Jira Cloud issues with ADF descriptions, subtasks, and epic links."
section: "PM"
order: 4
dateModified: 2026-07-23
tags: ["jira", "devintern/pm", "integration", "jira cloud"]
---

# Create Jira Issues with @devintern/pm

@devintern/pm creates Jira Cloud issues directly from AI-generated stories and tasks. Setup takes a few minutes: you need your site URL, account email, an API token, and a default project key.

## How It Works

@devintern/pm uses the [Jira Cloud REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) to create issues in a project you configure.

- New work items appear as **issues** in the target project with the issue type you select (Story, Task, Bug, Epic, etc.)
- Descriptions are converted from markdown to **Atlassian Document Format (ADF)** so headings, lists, and inline formatting render in Jira
- Subtasks are created as **Subtask** issue types linked to the parent issue
- Epic links set the story's **parent** field to the epic issue key
- Issue types are fetched from your Jira project's configuration: pick one that exists in your project

This integration targets **Jira Cloud** (`*.atlassian.net`). Jira Data Center / Server is not supported.

## Setup

### 1. Set the backend

In your `.devintern-pm/.env`:

```bash
TASK_TRACKER=jira
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-api-token
JIRA_DEFAULT_PROJECT_KEY=PROJ
```

All four Jira variables are required. `TASK_TRACKER` defaults to `jira` if omitted.

### 2. Find your Jira site URL

Your site URL is the hostname you use to open Jira in the browser:

```
https://your-org.atlassian.net/jira/...
        └─ JIRA_BASE_URL ─┘
```

Set `JIRA_BASE_URL` to the full URL **without** a trailing slash. `https://` is optional: @devintern/pm strips it automatically.

### 3. Create an API token

1. Go to [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**, add a label (e.g. `DevIntern`), and copy the token
3. Paste the token into `JIRA_API_TOKEN`

Use the **email address** of the Atlassian account that owns the token for `JIRA_EMAIL`. Authentication is Basic auth (`email:token`).

Store credentials in `.devintern-pm/.env`. That file should stay out of version control (`devpm init` adds it to `.gitignore`).

### 4. Set your default project key

The project key is the short uppercase prefix on issue keys (e.g. `PROJ` in `PROJ-123`).

Find it in:

- Any issue URL: `https://your-org.atlassian.net/browse/PROJ-123` → `PROJ`
- **Project settings → Details → Key**

In interactive mode you can switch projects with **Ctrl+P** before confirming, but `JIRA_DEFAULT_PROJECT_KEY` is still required.

### 5. Create your first issue

```bash
devpm --interactive
```

The issue type step lists types configured in your Jira project (Story, Task, Bug, Epic, or custom types from your scheme).

## Issue Types

Available types depend on your Jira project and issue type scheme. @devintern/pm fetches non-subtask types from the project API.

Pick a type that exists in your project. If you choose a type that is not available (e.g. **Epic** on a project that does not use epics), Jira may reject the request.

## What Gets Created

| devpm concept             | Jira object                                      |
| ------------------------- | ------------------------------------------------ |
| Story / Bug / Task / Epic | Issue of the selected type in the target project |
| Subtask                   | Subtask issue linked to the parent issue         |
| Epic link                 | Parent field set to the epic issue key           |

When linking to an epic, enter the epic's issue key (e.g. `PROJ-42` from `.../browse/PROJ-42`).

## Troubleshooting

**"Jira backend selected but … configuration is missing"**

Set all four variables in `.devintern-pm/.env`: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `JIRA_DEFAULT_PROJECT_KEY`.

**"Jira API error (401)"**

- API token is invalid or revoked: create a new token at [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
- `JIRA_EMAIL` does not match the account that created the token
- Confirm the token was copied without extra spaces

**"Jira API error (403)"**

- Your account lacks permission to create issues in the target project
- Ask a Jira admin to add you to the project with **Create issues** permission

**"Jira API error (400)" when creating issues**

- The selected issue type is not valid for this project: pick a type from the list in interactive mode
- `JIRA_DEFAULT_PROJECT_KEY` is wrong: verify the key in **Project settings → Details**

**Epic link fails**

- Enter a valid epic issue key (e.g. `PROJ-100`), not a numeric ID
- The epic must exist in a project your account can access
- Some Jira configurations use **Epic Link** custom fields instead of parent: @devintern/pm sets the **parent** field (works with team-managed projects and modern company-managed epics)

**Descriptions show unformatted markdown**

Descriptions are converted to ADF before create. If formatting is missing, check that the description is standard markdown (headings, lists, bold): exotic syntax may not map to ADF.

**Project picker (Ctrl+P) shows other projects but defaults elsewhere**

Issues are created in the project selected in interactive mode, or in `JIRA_DEFAULT_PROJECT_KEY` when not overridden.
