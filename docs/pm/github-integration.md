---
title: "Create GitHub Issues with @devintern/pm"
sidebarLabel: "GitHub Issues Integration"
description: "File well-specified GitHub issues from AI drafts in your repository."
section: "PM"
order: 6
---

# Create GitHub Issues with @devintern/pm

@devintern/pm creates GitHub Issues directly from AI-generated stories and tasks. Setup takes a few minutes: you need a Personal Access Token and a target repository.

## How It Works

@devintern/pm uses the [GitHub REST Issues API](https://docs.github.com/en/rest/issues) to create and update issues in a repository you configure.

- New issues appear under the repo's **Issues** tab
- Stories, bugs, tasks, and epics map to issue labels (see below)
- Subtasks become linked issues with a task list on the parent issue
- Epic linking is not supported: GitHub Issues has no native parent hierarchy, so the epic linking step is skipped in interactive mode and the `--epic` flag is ignored

## Setup

### 1. Set the backend

In your `.devintern-pm/.env`:

```bash
TASK_TRACKER=github
GITHUB_REPO=your-username-or-org/your-repo
```

`GITHUB_REPO` is the repository in `owner/repo` form (e.g. `acme/my-app`).

All issues are created in this repository.

### 2. Create a Personal Access Token

Both token types work. **Fine-grained tokens are recommended**: they grant only the permissions @devintern/pm needs on specific repositories.

#### Fine-grained (recommended)

1. Go to [Fine-grained tokens → Generate new token](https://github.com/settings/personal-access-tokens/new)
2. Set **Repository access** to include your target repo (and any others you want visible in the Ctrl+P repo picker)
3. Under **Permissions → Repository permissions**, set:
   - **Issues:** Read and write
   - **Metadata:** Read (required; selected automatically)
4. Generate the token and copy it

For organization-owned repositories, an org admin may need to **approve** the token before it works.

#### Classic

1. Go to [Classic tokens → Generate new token](https://github.com/settings/tokens/new)
2. Select scopes:
   - **Private repositories:** `repo` (full control of private repositories)
   - **Public repositories only:** `public_repo`
3. Generate the token and copy it

Classic tokens with `repo` work but grant broader access than necessary.

### 3. Add the token to your config

```bash
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
```

Run `devpm --interactive` to create your first issue.

## Issue Types and Labels

When you pick an issue type in @devintern/pm, it applies a GitHub label:

| devpm issue type | GitHub label  |
| ---------------- | ------------- |
| Story            | `enhancement` |
| Bug              | `bug`         |
| Task             | `task`        |
| Epic             | `epic`        |

New repositories include `bug` and `enhancement` by default. Create `task` and `epic` labels in your repo if you use those issue types: otherwise GitHub may reject the request when applying a missing label.

## What Gets Created

| devpm concept             | GitHub object                                                 |
| ------------------------- | ------------------------------------------------------------- |
| Story / Bug / Task / Epic | Issue with title, body, and mapped label                      |
| Subtask                   | New issue linked from a `## Subtasks` task list on the parent |
| Epic link                 | Not supported (step is skipped)                               |

## Troubleshooting

**"Missing required environment variables" / GitHub configuration errors**

Set both `GITHUB_TOKEN` and `GITHUB_REPO` (as `owner/repo`) in `.devintern-pm/.env`.

**"GitHub API error (401)"**

- Token is invalid or expired: generate a new one
- For fine-grained tokens on org repos, check whether an admin still needs to approve the token

**"GitHub API error (403)"**

- Token lacks **Issues: Read and write** (fine-grained) or `repo` / `public_repo` (classic)
- Token does not have access to the configured repository
- Your account lacks permission to create issues in that repo

**"GitHub API error (422)" when creating issues**

- A mapped label (`task`, `epic`, etc.) does not exist in the repository: create it under **Issues → Labels**, or pick an issue type whose label already exists

**Repo picker (Ctrl+P) shows other repos but issues go elsewhere**

Issues are always created in the repository set by `GITHUB_REPO`. The picker lists repositories your token can access for reference; changing the selection does not redirect issue creation yet.
