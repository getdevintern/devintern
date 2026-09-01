---
title: "Create Azure DevOps Work Items with @devintern/pm"
sidebarLabel: "Azure DevOps Integration"
description: "File well-specified Azure DevOps work items from AI drafts in your project."
section: "PM"
order: 9
sidebarHidden: true
---

# Create Azure DevOps Work Items with @devintern/pm

@devintern/pm creates Azure DevOps work items directly from AI-generated stories and tasks. Setup takes a few minutes: you need a Personal Access Token, your organization slug, and a target project.

## How It Works

@devintern/pm uses the [Azure DevOps Work Items REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items) to create items in a project you configure.

- New work items appear in the target **project** with the issue type you select (User Story, Bug, Task, etc.)
- Descriptions are converted from markdown to **HTML** for `System.Description` (Azure DevOps defaults to HTML; raw markdown would display as plain text)
- Subtasks are created as **Task** work items linked as children of the parent
- Epic links use Azure DevOps parent/child hierarchy relationships
- Work item IDs are numeric (e.g. `123`): use the ID from the work item URL when linking epics

This integration targets **Azure DevOps Services** (`dev.azure.com`). Self-hosted Azure DevOps Server is not supported.

## Setup

### 1. Set the backend

In your `.devintern-pm/.env`:

```bash
TASK_TRACKER=azure-devops
AZURE_DEVOPS_ORG=your-organization
AZURE_DEVOPS_PAT=your-pat-token
AZURE_DEVOPS_PROJECT=YourProject
```

All three Azure DevOps variables are required.

### 2. Find your organization slug

Open your organization in the browser. The slug is the segment after `dev.azure.com/`:

```
https://dev.azure.com/contoso/MyProject/_workitems/edit/123
                    └─ org ─┘
```

Set `AZURE_DEVOPS_ORG=contoso`: the slug only, not the full URL.

### 3. Create a Personal Access Token

1. Go to [Personal Access Tokens](https://dev.azure.com/your-org/_usersSettings/tokens) (replace `your-org` with your organization slug)
2. Click **+ New Token**
3. Set a name (e.g. `DevIntern`) and choose an expiration
4. Under **Scopes**, enable:
   - **Work Items:** Read & write
   - **Project and Team:** Read
5. Under **Organizations**, select your org (or **All accessible organizations** if you use multiple)
6. Create the token and copy it into `AZURE_DEVOPS_PAT`

Store the PAT in `.devintern-pm/.env`. That file should stay out of version control (`devpm init` adds it to `.gitignore`).

### 4. Set your default project

`AZURE_DEVOPS_PROJECT` must match the project **name** exactly as shown in Azure DevOps, not the project ID or description.

Find it in the URL when you open a board or backlog:

```
https://dev.azure.com/contoso/MyProject/_boards/board/t/...
                              └─ project name ─┘
```

Or copy the name from **Project settings → Overview**.

In interactive mode you can switch projects with **Ctrl+P** before confirming, but `AZURE_DEVOPS_PROJECT` is still required as the default.

### 5. Create your first work item

```bash
devpm --interactive
```

The issue type step lists work item types from your project's process template (Agile, Scrum, Basic, CMMI, or a custom process).

## Issue Types

Available types depend on your Azure DevOps process template:

| Process template | Common types                                   |
| ---------------- | ---------------------------------------------- |
| Agile            | Epic, Feature, User Story, Task, Bug           |
| Scrum            | Epic, Feature, Product Backlog Item, Task, Bug |
| Basic            | Epic, Issue, Task                              |
| CMMI             | Epic, Feature, Requirement, Task, Bug          |

@devintern/pm fetches the types configured in your project. Pick a type that exists in your process. If you choose a type that is not defined, work item creation will fail.

## What Gets Created

| devpm concept             | Azure DevOps object                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------- |
| Story / Bug / Task / Epic | Work item of the selected type in the target project (markdown → HTML in Description) |
| Subtask                   | **Task** work item linked as a child of the parent                                    |
| Epic link                 | Parent/child hierarchy link between work items                                        |

When linking to an epic, enter the parent work item's **numeric ID** (from the URL: `.../_workitems/edit/456` → `456`), not a Jira-style key like `PROJ-123`.

## Troubleshooting

**"Azure DevOps backend selected but … configuration is missing"**

Set all three variables in `.devintern-pm/.env`: `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PAT`, and `AZURE_DEVOPS_PROJECT`.

**"Azure DevOps API error (401)"**

- PAT is invalid or expired: create a new token
- Confirm the token was copied without extra spaces
- Verify the token's organization scope includes the org in `AZURE_DEVOPS_ORG`

**"Azure DevOps API error (403)"**

- PAT lacks **Work Items (Read & write)** scope: regenerate with the correct permissions
- Your account may not have permission to create work items in the target project: ask a project admin to grant **Contributors** access or equivalent

**"Azure DevOps API error (404)" when creating work items**

- `AZURE_DEVOPS_ORG` or `AZURE_DEVOPS_PROJECT` is wrong: check the slug and project name against your Azure DevOps URL
- Project name is case-sensitive and must match exactly (including spaces)

**Work item creation fails with an invalid work item type**

- The selected type does not exist in your process template (e.g. choosing **Story** on a Scrum project that uses **Product Backlog Item**)
- Re-run interactively and pick a type from the list, or use `--type` with a valid type name for your project

**Descriptions show raw markdown syntax (e.g. `##`, `**bold**`)**

Azure DevOps `System.Description` defaults to **HTML** via the REST API. @devintern/pm converts markdown to HTML before creating the work item. If you still see unrendered markdown on older work items, those were likely created before this conversion was added.

Azure DevOps also supports an opt-in **Markdown** format (`/multilineFieldsFormat/System.Description` = `Markdown`) on organizations with the New Boards markdown editor. @devintern/pm uses HTML for compatibility with the default format.

**Subtask creation fails**

- Subtasks are always created as **Task** work items. If your process template does not include Task (unusual), subtask creation will fail
- Confirm the parent key is a numeric work item ID that exists in the project

**Epic link fails with "Work item not found"**

- Azure DevOps uses numeric IDs, not Jira-style keys: enter the epic's work item ID (e.g. `456` from `.../_workitems/edit/456`)
- Both the story and epic must exist in a project your PAT can access

**Project picker (Ctrl+P) shows other projects but defaults elsewhere**

Work items are created in the project selected in interactive mode, or in `AZURE_DEVOPS_PROJECT` when not overridden. Ensure the default project name matches the project you intend to use.
