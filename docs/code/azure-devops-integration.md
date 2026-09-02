---
title: "Implement Azure DevOps Work Items with @devintern/code"
sidebarLabel: "Azure DevOps Integration"
description: "Fetch Azure DevOps work items, run WIQL batches, implement with your coding agent, and post PRs and state transitions back."
section: "Code"
order: 5
sidebarHidden: true
dateModified: 2026-07-23
tags: ["azure-devops", "devintern/code", "integration"]
---

# Implement Azure DevOps Work Items with @devintern/code

@devintern/code can implement work directly from Azure DevOps work items: fetch work item details and comments, run a feasibility check, move the item through workflow states, execute your AI agent, commit changes, open a pull request, and post results back to the work item.

## Prerequisites

- [Bun](https://bun.sh) and `@getdevintern/code` installed globally
- Azure DevOps Personal Access Token (PAT) with Work Items read/write
- Git repository for your project

## Setup

### 1. Set the task tracker

In `.devintern-code/.env`:

```bash
TASK_TRACKER=azure-devops
```

### 2. Add Azure DevOps credentials

```bash
AZURE_DEVOPS_ORG=your-organization
AZURE_DEVOPS_PAT=your-pat-token
AZURE_DEVOPS_PROJECT=YourProject
```

The organization is the segment after `dev.azure.com/` in your URLs. Create the PAT under User settings, Personal access tokens, with the **Work Items (Read and write)** scope. The project is the project name that contains your work items.

### 3. Configure state transitions

Edit `.devintern-code/settings.json` using the project name as the project key:

```json
{
  "azure-devops": {
    "projects": {
      "YourProject": {
        "inProgressStatus": "Active",
        "todoStatus": "New",
        "prStatus": "Resolved"
      }
    }
  }
}
```

State names must match the workflow states of your work item types (for example `New`, `Active`, `Resolved`, `Closed` in the Agile template). @devintern/code moves work items to:

- **inProgressStatus** when implementation starts (after the clarity check)
- **prStatus** after a pull request is created
- **todoStatus** when implementation is incomplete or max turns are reached

See [Configuration](./configuration.md) for all settings fields.

## Running a work item

Pass a numeric work item ID or a full work item URL:

```bash
# Work item ID
devintern 4211 --create-pr

# Full work item URL
devintern https://dev.azure.com/your-org/YourProject/_workitems/edit/4211 --create-pr
```

This workflow:

1. Fetches the work item description (HTML converted to markdown), tags, attachments, and comments
2. Runs a feasibility assessment (skippable with `--skip-clarity-check`)
3. Moves the item to `inProgressStatus` (unless `--skip-comments` is set)
4. Creates a feature branch, runs your agent, commits, and optionally opens a PR
5. Moves the item to `prStatus` after PR creation
6. Posts implementation or assessment comments on the work item

Parent, child, and related work item links are fetched and included in the agent context.

## Batch processing with --query

Select multiple work items with [WIQL](https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax), scoped to your configured project:

```bash
devintern --query "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'New'" --create-pr
devintern --query "SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS 'bug'" --create-pr
```

The first 100 matching work items are processed in sequence.

## Story points estimation

Estimation mode is fully supported via the `Microsoft.VSTS.Scheduling.StoryPoints` field (the Agile template default):

```bash
devintern 4211 --estimate
```

If your process template uses a different field (for example `Effort` in Scrum), set `storyPointsField` in `settings.json` for the project.

## Limitations

- **Description format:** work item descriptions are HTML. They are converted to markdown for the agent, and automation comments are converted from markdown to HTML before posting.
- **Comments API:** Azure DevOps work item comments use a preview API version (7.1-preview.3), pinned by the integration.
- **Comments:** use `--skip-comments` to skip work item comments and state transitions for a run.

## Troubleshooting

**"Missing required Azure DevOps environment variables"**

Ensure `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PAT`, and `AZURE_DEVOPS_PROJECT` are set in `.devintern-code/.env`.

**"Failed to move work item ... to state"**

State names differ per process template and work item type. Check the states available for the work item type in your project settings and match them exactly in `settings.json`.

**401 or 403 errors**

Verify the PAT has not expired and includes the Work Items (Read and write) scope for the target organization.
