---
title: "DevIntern Code Configuration"
sidebarLabel: "Configuration"
description: "Use when setting up the .env file, choosing a task tracker, connecting GitHub or Bitbucket, or finding the page for agent, sandbox, and advanced settings in DevIntern Code."
section: "Automation Reference"
order: 0
dateModified: 2026-11-26
---

# DevIntern Code Configuration

DevIntern Code keeps its settings in `~/.devintern`, outside your repositories. `devintern init` registers the current repository in `~/.devintern/workspace.toml` (as a `manual_only` repo, which the [worker](./worker.md) skips) and writes its settings to `~/.devintern/env/<repo>.env`. Each repository has its own file, so several projects can use different trackers and credentials. A repository without a GitHub, GitLab, or Bitbucket `origin` (for example a fresh `git init`) is registered by its directory instead.

In a terminal, the wizard asks which tracker you use, links to the provider's token page, checks the credentials, and writes the file. With `--yes` (or `--no-interactive`), or when stdin is not a terminal, it writes a commented template for you to fill in instead. Run `devintern init` again in the repository to update the file.

### Moving from `.devintern-code/`

Older releases kept settings in the repository's `.devintern-code/` folder. The first time this release runs in such a repository (any `devintern` task run or `devintern init`), it moves them automatically:

- `.devintern-code/.env` becomes `~/.devintern/env/<repo>.env`, and the repository is registered as a `manual_only` repo.
- Your sign-in moves to `~/.devintern/state/code/`.
- Status names from `.devintern-code/settings.json` are copied to `[trackers]` in `~/.devintern/workspace.toml`. The worker does the same for the repositories it runs when it starts.

Committed files (`settings.json`, `.env.example`) are left in place; delete them from the repository once everyone has upgraded. Past manual run history is not carried over.

More settings:

- [Agent Harness](./agent-harness.md): which AI agent runs, models, reasoning effort, failover, per-task overrides.
- [Sandboxing the Agent](./sandboxing.md): confining agent runs with `native`, `nono`, or Docker Sandboxes.
- [Advanced Settings](./advanced-settings.md): timeouts, auto-review, logging, telemetry, output directory, prompt overrides, tracker status settings, and `devintern doctor`.

## Environment file locations

In a repository registered in `~/.devintern/workspace.toml`, settings come from the workspace: the shared `~/.devintern/.env`, then the repo's `env_file` and `[repos.env]` (see [Workspaces](./workspaces.md)); `--env-file` still applies on top. Otherwise DevIntern looks for `.env` in this order and uses the first match: `--env-file <path>`, then `.env` in the current directory and each parent up to the git root, then `~/.env`, then the tool's install directory. This means you can run `devintern` from any subdirectory of the project. With `--env-file`, only that file is loaded. Values in the file override variables already set in your shell.

## Choosing a task tracker

Set `TASK_TRACKER` to pick the tracker. The default is `jira`.

| `TASK_TRACKER` | Credentials and setup                                         |
| -------------- | ------------------------------------------------------------- |
| `jira`         | [Jira Integration](./jira-integration.md)                     |
| `linear`       | [Linear Integration](./linear-integration.md)                 |
| `trello`       | [Trello Integration](./trello-integration.md)                 |
| `asana`        | [Asana Integration](./asana-integration.md)                   |
| `azure-devops` | [Azure DevOps Integration](./azure-devops-integration.md)     |
| `github`       | [GitHub Issues Integration](./github-issues-integration.md)   |
| `gitlab`       | [GitLab Integration](./gitlab-integration.md)                 |
| `markdown`     | [Markdown File Tasks](./markdown-tasks.md) (no credentials)   |

```bash
# Example: Jira
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your-api-token
```

Status transitions and story-point fields go in `[trackers]` in `workspace.toml`; see [Tracker status settings](./advanced-settings.md#tracker-status-settings).

## GitHub authentication

Set `GITHUB_TOKEN` for CLI runs and for workspace automation. A workspace paired with the hosted [relay](./relay.md) receives events through the central [DevIntern AI App](https://github.com/apps/devintern-ai/installations/new); the token stays on your machine and you don't create a GitHub App yourself. Unattended runs also need a `LICENSE_KEY` ([pricing](https://devintern.com/pricing/)).

| What you want                                                 | Need                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| Implement tickets and open PRs from the CLI                   | `GITHUB_TOKEN`                                        |
| GitHub Issues as the task tracker (`TASK_TRACKER=github`)     | `GITHUB_TOKEN` (an App cannot substitute)             |
| Worker review polling and replies                             | `GITHUB_TOKEN`                                        |
| `@devintern-ai` on any PR                                     | `GITHUB_TOKEN` + relay + DevIntern AI App installation |
| Air-gapped mentions, `devintern webhook serve`, or custom `slug[bot]` attribution | Customer-owned GitHub App (below)   |

**Token permissions.** A classic token needs the `repo` scope. A fine-grained token (recommended) needs `Contents: Read and write` and `Pull requests: Read and write`. Add `Checks: Read` and `Commit statuses: Read` when `[workspace].auto_merge = true` (auto-merge reads every PR's CI checks, including PRs that only touch safe paths), `Actions: Read` and `Commit statuses: Read` when `[workspace].ci_failure_fix = true`, and `Issues: Read and write` when `TASK_TRACKER=github`. Create tokens at [github.com/settings/tokens](https://github.com/settings/tokens).

> `Contents` must be **Read and write**. With read-only Contents, task fetching and PR reads work but `git push` fails with `403`. For `https://github.com` remotes, clones, fetches, and pushes use `GITHUB_TOKEN` when git has no credential helper of its own; the token is passed to git in memory, never written to `.git/config` or a remote URL. A configured helper (for example `gh auth setup-git` or a keychain) is used instead, and `gh` itself serves an exported `GITHUB_TOKEN` ahead of its keyring login. SSH remotes use your SSH keys. The worker test-pushes each GitHub HTTPS remote at startup and warns if the push is rejected.

**Bot aliases.** Relay-backed workspaces recognize `@devintern-ai` automatically. To treat other bot logins as mentions too, set `GITHUB_BOT_ALIASES` to a comma-separated list (with or without the `[bot]` suffix).

### Advanced: customer-owned GitHub App

Use your own GitHub App only when you can't use the relay (for example, an air-gapped installation) or when you run `devintern webhook serve` against your own endpoint. It provides the bot identity for `@mention` matching and custom `slug[bot]` attribution.

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/secure/path/to/your-app.private-key.pem
# or, for CI: GITHUB_APP_PRIVATE_KEY_BASE64=$(base64 -w 0 your-app.private-key.pem)
```

You need both the ID and a private key. An ID on its own does nothing. Create the App under **Settings → Developer settings → GitHub Apps** with repository permissions **Contents**, **Pull requests**, and **Issues** set to Read and write, plus **Checks** and **Commit statuses** set to Read if auto-merge is on, and **Actions** and **Commit statuses** set to Read if automatic CI fixes are on. Generate a private key and install the App on your repositories. The webhook server needs more permissions; see [GitHub Webhooks and PR Automation](./github-integration.md#update-app-permissions).

When both a token and an App are configured, relay workspaces use only `GITHUB_TOKEN`, no-relay workspaces and `devintern webhook serve` prefer the App, and the CLI prefers `GITHUB_TOKEN` when it creates PRs.

### Bitbucket

```bash
BITBUCKET_TOKEN=your-bitbucket-token
```

Needs the `Repositories: Write` permission. Create it at [bitbucket.org/account/settings/app-passwords](https://bitbucket.org/account/settings/app-passwords/).

## Agent harness

`AGENT_HARNESS` selects the AI agent CLI. The default is `claude-code`. A comma-separated list such as `claude-code,codex` makes the worker switch to the next agent when one hits a usage limit. For models, effort, CLI paths, and per-harness notes, see [Agent Harness](./agent-harness.md).

## Sandboxing the agent

Agents run with their permission prompts turned off, so by default they can do anything your user account can. Set `AGENT_SANDBOX=auto` (or pass `--sandbox <provider>`) to run every agent inside an OS-level sandbox. Run `devintern sandbox` to see which providers are installed. See [Sandboxing the Agent](./sandboxing.md).

### What the sandbox allows

The agent can write to the working directory, the task output directory, the temp directory, browser caches, and its own state directories. Everything else is read-only, and network access is open by default. See [What the sandbox allows](./sandboxing.md#what-the-sandbox-allows) for the full list and the variables that change it.

## CLI updates

A globally installed `devintern` checks npm for a newer version at most once a day.

| Mode                                     | Behavior                                                         |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Interactive terminal                     | Asks `Update? (Y/n)`, installs, and re-runs your command         |
| Non-interactive (CI, workers, scripts)   | Doesn't install. Prints a one-line notice                        |
| Opt out                                  | `DEVINTERN_NO_UPDATE=1` or `--no-update`                         |
| Always auto-install (even non-interactive) | `DEVINTERN_AUTO_UPDATE=1`                                      |

Only global npm or bun installs are updated. To upgrade now, run `bun install -g @getdevintern/code@latest` (or `npm install -g ...`). To force a fresh check, delete `~/.devintern/update-check.json`.

## Troubleshooting

Run `devintern doctor` first: it checks the runtime, agent CLI, tracker credentials, sign-in, and license, and gives a fix for each failure ([details](./advanced-settings.md#readiness-check)).

- **"Missing required environment variables"**: make sure `~/.devintern/env/<repo>.env` exists (run `devintern init` in the repository) and the variable names are spelled exactly right (they are case-sensitive).
- **"Not in a git repository"**: run `git init`, or pass `--no-git`.
- **`<Harness> CLI not found`**: install the agent CLI and put it on your `PATH`, or set `AGENT_CLI_PATH` / `--agent-path`.
- **"Unknown agent harness"**: check how `AGENT_HARNESS` is spelled (kebab-case, for example `claude-code`). The error message lists every valid name.
- **Push fails with `403`**: your token needs `Contents: Read and write` (see [GitHub authentication](#github-authentication)).

If something looks like a DevIntern bug rather than a configuration problem, file it with `devintern report` ([Reporting bugs](./reporting-bugs.md)).
