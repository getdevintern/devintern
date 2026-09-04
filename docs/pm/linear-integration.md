---
title: "Create Linear Issues with @devintern/pm"
sidebarLabel: "Linear Integration"
description: "Create well-specified Linear issues and sub-issues from AI drafts in your workspace."
section: "PM"
order: 8
sidebarHidden: true
dateModified: 2026-07-23
tags: ["linear", "devintern/pm", "integration"]
---

# Create Linear Issues with @devintern/pm

@devintern/pm creates Linear issues directly from AI-generated stories and tasks. Setup takes a few minutes: you need a Personal API key and optionally a default team.

## How It Works

@devintern/pm uses the [Linear GraphQL API](https://developers.linear.app/docs/graphql/working-with-the-graphql-api) to create issues in a team you configure.

- New work items appear as **issues** in the target team (descriptions are sent as markdown, which Linear renders natively)
- Subtasks are created as sub-issues linked to the parent issue
- Epic links use Linear's parent-issue relationship
- Issue type selection is skipped: Linear does not expose Jira-style issue types through this integration

## Setup

### 1. Set the backend

In your `.devintern-pm/.env`:

```bash
TASK_TRACKER=linear
LINEAR_API_KEY=lin_api_xxxxxxxxxxxx
```

### 2. Create a Personal API key

1. Go to [Linear API settings](https://linear.app/settings/api)
2. Under **Personal API keys**, click **Create key**
3. Add a label (e.g. `DevIntern`) and copy the key into `LINEAR_API_KEY`

The key starts with `lin_api_` and cannot be viewed again after you leave the page. Store it in `.devintern-pm/.env`. That file should stay out of version control (`devpm init` adds it to `.gitignore`).

The key inherits your Linear account permissions: you can create issues in any team you belong to.

### 3. (Optional) Pin a default team

If you omit `LINEAR_DEFAULT_TEAM_KEY`, @devintern/pm uses the first accessible team. To always create issues in a specific team, set:

```bash
LINEAR_DEFAULT_TEAM_KEY=ENG
```

#### Finding your team key

The team key is the short prefix before the issue number in identifiers like `ENG-42` or `DES-7`.

You can find it in either place:

- **From an issue:** open any issue in the team. The identifier prefix is the team key (`ENG` in `ENG-42`)
- **From team settings:** Linear → **Settings** → **Teams** → select your team → **Key**

In interactive mode you can also pick a team with **Ctrl+P** before confirming.

### 4. Create your first issue

```bash
devpm --interactive
```

## What Gets Created

| devpm concept      | Linear object                            |
| ------------------ | ---------------------------------------- |
| Story / Task / Bug | Issue in the target team                 |
| Subtask            | Sub-issue linked to the parent issue     |
| Epic link          | Parent issue relationship via `parentId` |

## Troubleshooting

**"Linear backend selected but LINEAR_API_KEY is missing"**

Set `LINEAR_API_KEY` in `.devintern-pm/.env` after creating a key at [Linear API settings](https://linear.app/settings/api).

**"Linear API error (401)"**

- API key is invalid or revoked: create a new Personal API key
- Confirm the key was copied without extra spaces or a `Bearer` prefix (paste the raw `lin_api_…` value)

**"No Linear teams found"**

Your account has no teams yet, or the API key's user cannot see any. Create a team in Linear first, or ask a workspace admin to add you to one.

**Issues land in the wrong team**

- Set `LINEAR_DEFAULT_TEAM_KEY` to the key from that team's settings or issue identifiers
- In interactive mode, pick the correct team with **Ctrl+P** before confirming

**"Could not fetch teams" warning in interactive mode**

- Check `LINEAR_API_KEY` and network access to `api.linear.app`
- Ensure your Linear account belongs to at least one team
