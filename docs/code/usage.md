---
title: "DevIntern Code Usage Guide"
sidebarLabel: "CLI Reference"
description: "Use when looking up DevIntern Code CLI commands and flags for single tasks, markdown tasks, batch runs, git behavior, and outputs."
section: "Automation Reference"
order: 1
dateModified: 2026-11-18
---

# DevIntern Code Usage Guide

`devintern` takes one or more task references, or a `--query`, and runs your AI agent on each task in the current repository. Run `devintern --help` for the version you have installed.

```bash
devintern PROJ-123 --create-pr                 # one tracker task, then open a PR
devintern ./tasks/feature-spec.md --create-pr  # a local markdown file, no tracker needed
devintern PROJ-123 PROJ-124 PROJ-125           # several tasks, in sequence
devintern --query "project = PROJ AND status = 'To Do'" --create-pr
```

## Task references

| Tracker                         | Reference                                                     |
| ------------------------------- | ------------------------------------------------------------- |
| Jira (default)                  | `PROJ-123`                                                    |
| Linear (`TASK_TRACKER=linear`)  | `ENG-42` or the issue URL                                     |
| GitHub Issues / GitLab          | `123`, `#123` (GitHub), or the issue URL                      |
| Azure DevOps                    | Work item ID (`4211`) or URL                                  |
| Asana                           | Task ID or URL                                                |
| Trello (`TASK_TRACKER=trello`)  | Card short link (`4uWKPOTv`), full card URL, or 24-char ID    |
| Markdown file                   | A path such as `./tasks/feature-spec.md`; no credentials needed |

You can mix a tracker task with local files: `devintern PROJ-123 ./extra-context.md`. See [Markdown File Tasks](./markdown-tasks.md) for frontmatter, status tracking, and `TASK_TRACKER=markdown` mode.

## Options

| Flag                                | Default         | Effect                                                                                                                                  |
| ----------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--query <query>`                   |                 | Select tasks in bulk. Syntax depends on the tracker (see [Batch runs](#batch-runs)). `--jql` is a deprecated alias.                     |
| `--create-pr`                       | off             | Push the branch and open a pull request after the run.                                                                                  |
| `--pr-target-branch <branch>`       | repo default    | Base branch for the PR. Falls back to the repository default branch if the named branch does not exist on the remote.                   |
| `--auto-review`                     | off             | Run the automatic review-and-fix loop after creating the PR (requires `--create-pr`). See [Auto-Review Loop](./advanced-settings.md#auto-review-loop). |
| `--auto-review-iterations <n>`      | `2`             | Maximum review-fix cycles for `--auto-review` (env: `AUTO_REVIEW_ITERATIONS`).                                                          |
| `--no-git`                          | off             | Skip branch creation.                                                                                                                   |
| `--no-auto-commit`                  | off             | Do not commit after the agent finishes.                                                                                                 |
| `--hook-retries <n>`                | `10`            | Times the agent may repair a failing git hook before the commit is retried through the hooks (never `--no-verify`). `0` disables repair. |
| `--allow-no-changes`                | off             | Treat a run that changes nothing as a successful no-op.                                                                                 |
| `--max-turns <n>`                   | `500`           | Maximum agent turns for very large tasks.                                                                                               |
| `--skip-clarity-check`              | off             | Skip the feasibility assessment before implementation.                                                                                  |
| `--skip-comments`                   | off             | Post no tracker comments and make no Trello list transitions.                                                                           |
| `--force`                           | off             | Re-run a task that was reported incomplete even though the ticket is unchanged. Normally you edit the description or add a comment instead. |
| `--estimate`                        | off             | Add story-point estimates instead of implementing. See [Story Points Estimation](./story-points-estimation.md).                         |
| `--sandbox <provider>`              | `AGENT_SANDBOX` | Run the agent in a sandbox: `none`, `auto`, `native`, `nono`, or `docker`. See [Sandboxing the Agent](./configuration.md#sandboxing-the-agent). |
| `--agent-path <path>`               | `PATH` lookup   | Path to the agent CLI executable.                                                                                                       |
| `--env-file <path>`                 | workspace env files | Load a different `.env` file instead.                                                                                                    |
| `-v`, `--verbose`                   | off             | Verbose output for debugging.                                                                                                           |
| `--no-update`                       | off             | Skip the update check for this run.                                                                                                     |

The agent harness, model, and reasoning effort are set in your environment, not by flags. See [Agent Harness](./configuration.md#agent-harness) in the configuration guide.

## Subcommands

| Command                                  | Use it to                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `devintern init`                         | Set up this repository: choose a worker (runs `worker init`) or manual runs (`--yes` for a template). |
| `devintern doctor`                       | Check runtime, git, agent CLI, tracker credentials, sign-in, and license (worker checks in a worker repository). |
| `devintern worker`                       | Run the workspace worker. See [Worker](./worker.md).                          |
| `devintern dashboard`                    | Open run history without the worker. See [Dashboard](./dashboard.md).          |
| `devintern address-review`               | Address review feedback on an existing pull request.                          |
| `devintern resolve-conflicts`            | Merge a PR's base branch into it and resolve conflicts.                       |
| `devintern auto-merge`                   | Merge a PR if it is green and safe.                                           |
| `devintern sandbox`                      | Show available sandbox providers and what the next run will do.               |
| `devintern report`                       | File a redacted bug report. See [Reporting Bugs](./reporting-bugs.md).        |
| `devintern login` / `logout` / `whoami`  | Manage your DevIntern sign-in.                                                |

Run `devintern <subcommand> --help` for subcommand options.

## Batch runs

`--query` selects every matching task. Its syntax follows the tracker:

```bash
# Jira: JQL
devintern --query "assignee = currentUser() AND status = 'To Do'" --create-pr

# Linear: a JSON IssueFilter (single-quoted) or plain-text title search
devintern --query '{"labels":{"name":{"eq":"intern"}}}' --create-pr

# GitHub Issues / GitLab: search qualifiers
devintern --query "is:open label:bug" --create-pr
```

Each integration guide documents its query syntax, for example the [Linear `IssueFilter` schema](./linear-integration.md).

## What a run does

1. Fetches the task (description, supported custom fields, comments, attachments) and formats it for the agent.
2. Creates or switches to the branch `feature/<task-key>` in lowercase, for example `feature/proj-123`. The working tree must be clean.
3. Runs a feasibility check, unless `--skip-clarity-check` is set.
4. Runs the agent and saves its implementation summary.
5. Commits all changes as `feat: implement TASK-123 - Task Summary`.
6. With `--create-pr`, pushes the branch and opens a GitHub or Bitbucket pull request titled `[TASK-123] Task Summary`.
7. Posts the result to the tracker, unless `--skip-comments` is set.

If the agent ends by asking you a decision question, devintern posts the questions on the task and stops without committing or opening a PR. Answer in the task and run it again.

The PR body uses a fixed template: Why, What changed, Scope, Tradeoffs, Blast Radius, and Verification. A section shows `N/A` when the agent did not supply it.

### Target branch from the task

Instead of `--pr-target-branch`, a task description can name its base branch on its own line: `Target branch: develop` (also `Base branch:` or `PR target:`). The flag is used when no such line is found.

### Per-Task Execution Preferences

A task can override the agent harness, model, and reasoning effort for that task alone. Add a block to the description that starts with an `Execution preferences` heading:

```markdown
## Execution preferences
Harness: opencode
Model: anthropic/claude-opus-4-6
Effort: high
```

To keep the lines hidden in the rendered description, use a `devintern` HTML comment:

```markdown
<!-- devintern
Harness: codex
Model: gpt-5.2
Effort: high
-->
```

- Each line is optional. Omitted values use your defaults (`AGENT_HARNESS`, `AGENT_MODEL`, `AGENT_EFFORT`; see [Agent Harness](./configuration.md#agent-harness)).
- Labels are case-insensitive. `Agent harness:`, `Agent model:`, `Reasoning effort:`, and `Agent effort:` also work, and so does an `Agent execution preferences` heading. Only lines inside the block are read; `Harness:` elsewhere in the description is ignored, and so are code samples.
- The block ends at the next heading. Where a tracker flattens headings to plain text (Jira, Azure DevOps), it also ends at a blank line followed by ordinary prose. If your tracker drops the heading entirely, use the comment form.
- `Model:` is passed unchanged to the harness. DevIntern does not validate it.
- `Effort:` is `low`, `medium`, or `high`. Harnesses without reasoning effort ignore it with a warning.
- Setting only `Harness:` does not carry over `AGENT_MODEL`. The task uses `<HARNESS>_MODEL` if set, otherwise that harness's default. The CLI comes from `<HARNESS>_CLI_PATH` or your `PATH`.
- An unknown harness, an invalid effort, or the same label twice with different values fails the task with a message saying what to fix.
- During worker failover, a preference for a different harness than the active one is ignored with a warning.

The effective harness, model, and effort are printed before the run and saved in run history.

## Troubleshooting

**"There are uncommitted changes"**: commit or stash your changes, or pass `--no-git` to skip branch creation.

**Recovering work discarded before a branch was created**: uncommitted changes in the checkout are backed up before the feature branch is created, under `refs/devintern/backups/<task>-<timestamp>` rather than on your `git stash` list. List them with `git for-each-ref refs/devintern/backups/` and restore one with `git stash apply <ref-or-sha>`. Backups older than 30 days are deleted.

**"Agent reached maximum turns limit"**: raise `--max-turns` (for example `1000`) or split the task into smaller ones.

**"PR creation failed"**: check that your GitHub or Bitbucket token (or GitHub App installation) has access to the repository, then run again with `--verbose`. The branch is already pushed and a `Pull request could not be created` comment is posted on the ticket. Fix the cause and re-run with `--create-pr`.

**"Issue not found" / card fetch errors**: check the tracker credentials in `~/.devintern/env/<repo>.env` and that the task exists and you can access it. For Jira, check `JIRA_BASE_URL`. For Trello, set `TASK_TRACKER=trello`, `TRELLO_API_KEY`, and `TRELLO_API_TOKEN`.

Run `devintern doctor` to check your setup.
