---
title: "Create GitHub Issues with DevIntern PM"
sidebarLabel: "GitHub Issues Integration"
description: "File well-specified GitHub issues from AI drafts in your repository."
section: "Create Tasks"
order: 6
dateModified: 2026-11-18
sidebarHidden: true
---

# Create GitHub Issues with DevIntern PM

DevIntern PM creates GitHub Issues from AI-drafted stories, with labels by issue type and linked subtask issues.

## Prerequisites

- Permission to create issues in the target repository.
- The labels you plan to use (see [Usage](#usage)). New repos have `bug` and `enhancement` but not `task` or `epic`.

## Setup

Run `devpm init` and pick GitHub Issues, or set these in `.devintern-pm/.env`:

```bash
TASK_TRACKER=github
GITHUB_TOKEN=github_pat_xxxxxxxxxxxx
GITHUB_REPO=acme/my-app
```

| Variable       | Required | Where to find it                                                                                                                                                                                                                                         |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_REPO`  | yes      | The repository as `owner/repo`. All issues are created here.                                                                                                                                                                                             |
| `GITHUB_TOKEN` | yes      | Recommended: a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to the repo and **Issues: Read and write**. Or a [classic token](https://github.com/settings/tokens/new) with `repo` (private) or `public_repo`. |

For organization repos, an org admin may need to approve a fine-grained token before it works.

## Usage

```bash
devpm --interactive
```

| devpm issue type | GitHub label  |
| ---------------- | ------------- |
| Story            | `enhancement` |
| Bug              | `bug`         |
| Task             | `task`        |
| Epic             | `epic`        |

Subtasks become separate issues linked from a `## Subtasks` task list on the parent. GitHub has no parent hierarchy, so epic linking is skipped and `--epic` is ignored. File attachments stay draft context only; GitHub has no upload API for them.

The `Ctrl+P` picker lists repos your token can see, but issues are always created in `GITHUB_REPO`.

## Troubleshooting

**"Missing required environment variables"**: set both `GITHUB_TOKEN` and `GITHUB_REPO` (`owner/repo`).

**"GitHub API error (401)"**: the token is invalid or expired, or an org admin hasn't approved the fine-grained token yet.

**"GitHub API error (403)"**: the token lacks **Issues: Read and write** (or `repo` / `public_repo`), doesn't include the repo, or your account can't create issues there.

**"GitHub API error (422)"**: a mapped label (e.g. `task`, `epic`) doesn't exist. Create it under **Issues → Labels**, or pick another type.
