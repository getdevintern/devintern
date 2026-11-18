---
title: "Create Azure DevOps Work Items with DevIntern PM"
sidebarLabel: "Azure DevOps Integration"
description: "File well-specified Azure DevOps work items from AI drafts in your project."
section: "Create Tasks"
order: 9
dateModified: 2026-11-18
sidebarHidden: true
---

# Create Azure DevOps Work Items with DevIntern PM

DevIntern PM creates Azure DevOps work items from AI-drafted stories, with formatted descriptions, child tasks, and parent links.

## Prerequisites

- **Azure DevOps Services** (`dev.azure.com`). Self-hosted Azure DevOps Server is not supported.
- Permission to create work items in the project (e.g. **Contributors**).

## Setup

Run `devpm init` and pick Azure DevOps, or set these in `.devintern-pm/.env`:

```bash
TASK_TRACKER=azure-devops
AZURE_DEVOPS_ORG=contoso
AZURE_DEVOPS_PAT=your-pat-token
AZURE_DEVOPS_PROJECT=MyProject
```

| Variable               | Required | Where to find it                                                                                                                                         |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AZURE_DEVOPS_ORG`     | yes      | The slug after `dev.azure.com/` (`contoso` in `https://dev.azure.com/contoso/...`), not the full URL.                                                     |
| `AZURE_DEVOPS_PAT`     | yes      | `https://dev.azure.com/<org>/_usersSettings/tokens` → **New Token** with **Work Items: Read & write** and **Project and Team: Read**, scoped to your org. |
| `AZURE_DEVOPS_PROJECT` | yes      | The project **name** exactly as in the URL or **Project settings → Overview** (case-sensitive).                                                           |

## Usage

```bash
devpm --interactive
```

| devpm concept             | Azure DevOps object                                  |
| ------------------------- | ---------------------------------------------------- |
| Story / Bug / Task / Epic | Work item of the selected type in the target project |
| Subtask                   | **Task** work item, child of the parent              |
| Epic link                 | Parent/child link                                    |

The issue type step lists the types in your process template, e.g. **User Story** (Agile), **Product Backlog Item** (Scrum), **Issue** (Basic), or **Requirement** (CMMI). To link an epic, enter its numeric work item ID (`456` from `.../_workitems/edit/456`). Press `Ctrl+P` to use a different project for this run.

## Troubleshooting

**"Azure DevOps backend selected but … configuration is missing"**: set all three `AZURE_DEVOPS_*` variables.

**"Azure DevOps API error (401)"**: the PAT is invalid, expired, has extra spaces, or isn't scoped to the org in `AZURE_DEVOPS_ORG`.

**"Azure DevOps API error (403)"**: the PAT lacks **Work Items: Read & write**, or your account can't create work items in the project.

**"Azure DevOps API error (404)"**: the org slug or project name is wrong. The project name must match exactly, including case and spaces.

**Invalid work item type**: the type doesn't exist in your process (e.g. **Story** on Scrum). Pick from the interactive list or pass a valid `--type`.

**Subtask or epic link fails**: subtasks are always **Task** work items, so your process must include Task. Parents must be numeric IDs in a project your PAT can access.
