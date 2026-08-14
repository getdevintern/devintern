---
title: "Create Asana Tasks with @devintern/pm"
sidebarLabel: "Asana Integration"
description: "Create structured Asana tasks from AI drafts in the projects your team already uses."
section: "PM"
order: 7
---

# Create Asana Tasks with @devintern/pm

@devintern/pm creates Asana tasks directly from AI-generated stories and tasks. Setup takes a few minutes: you need a Personal Access Token and optionally a default project.

## How It Works

@devintern/pm uses the [Asana REST API](https://developers.asana.com/reference/rest-api-reference) to create tasks in a project you configure.

- New work items appear as **tasks** in the target project (descriptions use Asana rich text via `html_notes`, not raw markdown in `notes`)
- Subtasks are created as Asana subtasks on the parent task
- Epic links use Asana's parent-task relationship
- Issue type selection is skipped: Asana does not expose Jira-style issue types through this integration

## Setup

### 1. Set the backend

In your `.devintern-pm/.env`:

```bash
TASK_TRACKER=asana
ASANA_API_TOKEN=your-asana-pat
```

### 2. Create a Personal Access Token

1. Go to the [Asana developer console](https://app.asana.com/0/developer-console)
2. Create a new **Personal access token**
3. Copy the token into `ASANA_API_TOKEN`

The token must be able to read projects and create tasks in the workspaces you use.

### 3. (Optional) Pin a default project

If you omit `ASANA_DEFAULT_PROJECT_GID`, @devintern/pm uses the first accessible project. To always create tasks in a specific project, set:

```bash
ASANA_DEFAULT_PROJECT_GID=2222222222222222
```

#### Finding your project GID

Open the project in Asana and copy the numeric ID that appears right after `/project/` in the URL:

```
https://app.asana.com/1/1111111111111111/project/2222222222222222/list/3333333333333333
                                              └─ project GID ─┘
```

Use `2222222222222222` as `ASANA_DEFAULT_PROJECT_GID`. The first number is the workspace ID; the last number is a view/section ID. Neither of those is the project GID.

### 4. Create your first task

```bash
devpm --interactive
```

## What Gets Created

| devpm concept      | Asana object                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Story / Task / Bug | Task in the target project (markdown from devpm is converted to Asana HTML in `html_notes`) |
| Subtask            | Subtask under the parent task                                                               |
| Epic link          | Parent task relationship via `setParent`                                                    |

## Troubleshooting

**"Asana backend selected but ASANA_API_TOKEN is missing"**

Set `ASANA_API_TOKEN` in `.devintern-pm/.env` after creating a token in the [developer console](https://app.asana.com/0/developer-console).

**"Asana API error (401)"**

- Token is invalid or revoked: generate a new PAT
- Confirm the token was copied without extra spaces

**"Asana API error (403)"**

- Your account may lack permission to create tasks in the target project
- The project may be in a workspace the token cannot access

**Tasks land in the wrong project**

- Set `ASANA_DEFAULT_PROJECT_GID` to the numeric ID from that project's Asana URL
- In interactive mode, pick the correct project before confirming

**"Could not fetch projects" warning in interactive mode**

- Check `ASANA_API_TOKEN` and network access to `app.asana.com`
- Ensure your Asana account has at least one project; create one in the UI if needed
