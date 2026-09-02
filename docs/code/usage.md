---
title: "@devintern/code Usage Guide"
sidebarLabel: "CLI Reference"
description: "Commands, flags, batch runs, and outputs for working with @devintern/code."
section: "Automation"
order: 3
dateModified: 2026-07-23
---

# @devintern/code Usage Guide

## Single Task Processing

Process a single task from your configured tracker:

```bash
# Jira (default)
devintern TASK-123

# Linear (TASK_TRACKER=linear)
devintern ENG-42

# Trello (TASK_TRACKER=trello)
devintern 4uWKPOTv
devintern https://trello.com/c/4uWKPOTv/card-slug --create-pr

# Local markdown file (no PM credentials required)
devintern ./tasks/feature-spec.md
devintern /path/to/my-task.md --create-pr

# Skip git branch creation
devintern TASK-123 --no-git

# Use custom .env file
devintern TASK-123 --env-file /path/to/custom.env

# Verbose output for debugging
devintern TASK-123 -v

# Custom AI agent CLI path
devintern TASK-123 --agent-path /path/to/claude

# Override max turns for very complex tasks (default: 500)
devintern TASK-123 --max-turns 1000

# Skip automatic commit after AI agent completes
devintern TASK-123 --no-auto-commit

# Run directly in the current directory instead of an isolated git worktree
devintern TASK-123 --no-worktree-isolation

# Create pull request after implementation
devintern TASK-123 --create-pr

# Create PR targeting specific branch
devintern TASK-123 --create-pr --pr-target-branch develop

# Skip ALL task tracker comments (and Trello list transitions)
devintern TASK-123 --skip-comments

# Skip clarity check for faster processing
devintern TASK-123 --skip-clarity-check

# Re-run a task even if a previous attempt was reported incomplete
# and the ticket is unchanged (normally you edit the description or
# add a comment instead)
devintern TASK-123 --force
```

## Isolated Task Worktrees

By default, each task runs in a disposable git worktree so your uncommitted changes, staged files, and current branch are never touched. Results land on the task's `feature/<task-key>` branch; the worktree is removed automatically on success, failure, and interruption.

```bash
# Default: isolated (recommended)
devintern TASK-123

# Legacy behavior: run directly in your working directory
devintern TASK-123 --no-worktree-isolation
```

See [Worktree Isolation](./worktree-isolation.md) for lifecycle details, result access, orphan cleanup, and environment overrides.

## Markdown File Tasks

Pass one or more local `.md` files as arguments. No task tracker credentials are needed:

```bash
# Single file
devintern ./tasks/feature-spec.md --create-pr

# Multiple files (processed in sequence)
devintern ./epic.md ./subtask-a.md ./subtask-b.md

# Mix a PM task with a local file
devintern PROJ-123 ./extra-context.md
```

See the [Markdown File Tasks](./markdown-tasks.md) guide for frontmatter options, status tracking, and `TASK_TRACKER=markdown` mode.

## Batch Processing

Process multiple tasks at once. The query syntax depends on the active tracker; `--query` accepts JQL for Jira, and either a JSON `IssueFilter` or a plain-text title search for Linear. See the per-tracker integration guides for full details.

### Jira

```bash
# Process multiple specific tasks
devintern PROJ-123 PROJ-124 PROJ-125

# Process tasks matching a JQL query (Jira only; --jql is a deprecated alias)
devintern --query "project = PROJ AND status = 'To Do'"

# Complex JQL with custom fields
devintern --query "project = \"My Project\" AND cf[10016] <= 3 AND labels IN (FrontEnd, MobileApp)"

# Batch process with PR creation
devintern --query "assignee = currentUser() AND status = 'To Do'" --create-pr

# High-complexity batch with extended turns
devintern --query "labels = 'refactoring' AND type = Story" --max-turns 1000 --create-pr

# Batch with skipped clarity checks
devintern PROJ-101 PROJ-102 PROJ-103 --skip-clarity-check --create-pr
```

### Linear

```bash
# Process multiple specific issues
devintern ENG-42 ENG-43 ENG-44

# Process issues with a given label (e.g. "intern")
devintern --query '{"labels":{"name":{"eq":"intern"}}}' --create-pr

# Process "In Progress" issues assigned to me
devintern --query '{"state":{"name":{"eq":"In Progress"}},"assignee":{"isMe":{"eq":true}}}' --create-pr

# High-priority issues
devintern --query '{"priority":{"lte":2}}' --create-pr
```

Wrap JSON filters in single quotes so the shell does not interpret the inner double quotes. See the [Linear Integration guide](./linear-integration.md) for the full `IssueFilter` schema.

## Workflow Examples

### Standard Development Workflow

```bash
# 1. Go to your project directory
cd ~/projects/my-app

# 2. Check git status (should be clean)
git status

# 3. Run devintern
devintern MYAPP-456

# Expected output:
# 🔍 Fetching JIRA task: MYAPP-456
# 📋 Task Summary: Implement user authentication
# 💾 Saving formatted task details to: /tmp/devintern-tasks/myapp-456/task-details.md
# 🌿 Creating feature branch...
# ✅ Created and switched to new branch 'feature/myapp-456'
# 🤖 Running Claude Code with task details...
# [Agent implements the task...]
# ✅ Agent execution completed successfully
# 📝 Committing changes...
# ✅ Successfully committed changes for MYAPP-456
```

## Git Integration Details

### Automatic Branch Creation

- Creates branches with format: `feature/task-id`
- Converts task keys to lowercase: `PROJ-123` → `feature/proj-123`
- Checks for uncommitted changes before creating branches
- Switches to existing branch if it already exists

### Automatic Commit

- Commits all changes after AI agent successfully completes
- Uses descriptive commit message: `feat: implement TASK-123 - Task Summary`
- Can be disabled with `--no-auto-commit` flag
- Skipped when the agent ends its run by asking you decision questions (for example "How should I proceed?" or a list of options). devintern prints the questions, posts them as a comment on the task, and stops without committing or opening a PR. Answer in the task and re-run.

### Pull Request Creation

- Automatically creates PRs on GitHub or Bitbucket
- Detects repository platform from git remote URL
- PR title format: `[TASK-123] Task Summary`
- PR body includes implementation details and links back to the task
- Target branch can be specified with `--pr-target-branch`. If omitted (or if the named branch does not exist on the remote), the repository default branch is used
- Target branch can also be auto-detected from the task description. Add a line like `Target branch: develop` to the card or issue and `devintern` will pick it up. Supported patterns: `Target branch:`, `Base branch:`, `PR target:`. Falls back to `--pr-target-branch` if no pattern matches.

## What It Does

1. **Fetches** task details (description, custom fields where supported, comments, attachments)
2. **Formats** the information for your AI agent
3. **Creates** a feature branch named `feature/task-id`
4. **Runs** optional feasibility assessment (skippable with `--skip-clarity-check`)
5. **Executes** your AI agent with enhanced permissions (default: 500 max turns)
6. **Saves** implementation summary to local files
7. **Commits** all changes automatically
8. **Pushes** the feature branch (when creating PRs)
9. **Creates** pull requests on GitHub or Bitbucket (optional)
10. **Posts** implementation results back to your task tracker (skippable with `--skip-comments`)

## Troubleshooting

**"There are uncommitted changes"**

- Commit your changes: `git add . && git commit -m "message"`
- Or stash them: `git stash`
- Or use `--no-git` to skip branch creation

**"Agent reached maximum turns limit"**

- Task is too complex for the current turn limit (default: 500)
- Increase max turns: `--max-turns 1000`
- Consider breaking the task into smaller subtasks

**"PR creation failed"**

- Ensure you have the correct token configured
- Check token/App permissions
- For GitHub App: Ensure the App is installed on the repository
- Use `--verbose` flag to see detailed error messages

**"Issue not found" / card fetch errors**

- Check tracker credentials in `.devintern-code/.env`
- Verify the task key or card ID exists and you have access
- For Jira, ensure `JIRA_BASE_URL` is correct
- For Trello, confirm `TASK_TRACKER=trello` and both `TRELLO_API_KEY` and `TRELLO_API_TOKEN` are set
