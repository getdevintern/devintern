---
title: "Create Linear Issues with DevIntern PM"
sidebarLabel: "Linear Integration"
description: "Create well-specified Linear issues and sub-issues from AI drafts in your workspace."
section: "Create Tasks"
order: 8
sidebarHidden: true
dateModified: 2026-11-18
tags: ["linear", "devintern/pm", "integration"]
---

# Create Linear Issues with DevIntern PM

DevIntern PM creates Linear issues and sub-issues from AI-drafted stories.

## Prerequisites

- A Linear account that belongs to at least one team. The API key inherits your account's permissions.

## Setup

Run `devpm init` and pick Linear, or set these in `.devintern-pm/.env`:

```bash
TASK_TRACKER=linear
LINEAR_API_KEY=lin_api_xxxxxxxxxxxx
# LINEAR_DEFAULT_TEAM_KEY=ENG
```

| Variable                  | Required | Where to find it                                                                                                   |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `LINEAR_API_KEY`          | yes      | [Linear API settings](https://linear.app/settings/api) → **Personal API keys** → **Create key**. Shown only once.   |
| `LINEAR_DEFAULT_TEAM_KEY` | no       | The prefix on issue IDs (`ENG` in `ENG-42`), or **Settings → Teams → Key**. Defaults to your first team.           |

## Usage

```bash
devpm --interactive
```

| devpm concept      | Linear object                    |
| ------------------ | -------------------------------- |
| Story / Task / Bug | Issue in the target team         |
| Subtask            | Sub-issue of the parent          |
| Epic link          | Parent issue                     |

Linear has no Jira-style issue types, so that step is skipped. Press `Ctrl+P` to pick a different team for this run.

## Troubleshooting

**"Linear backend selected but LINEAR_API_KEY is missing"**: create a key and set `LINEAR_API_KEY`.

**"Linear API error (401)"**: the key is invalid or revoked. Paste the raw `lin_api_…` value, with no `Bearer` prefix or spaces.

**"No Linear teams found" / "Could not fetch teams"**: your account isn't in any team, or `api.linear.app` is unreachable. Ask an admin to add you to a team.

**Issues land in the wrong team**: set `LINEAR_DEFAULT_TEAM_KEY`, or pick the team with `Ctrl+P`.
