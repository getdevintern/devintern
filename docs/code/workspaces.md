---
title: "Workspaces (Multi-Repo Fleet)"
description: "Drive many repositories with one devintern worker: a single workspace.toml, routing rules, and per-task worktrees"
section: "Server Automation"
order: 1
dateModified: 2026-08-22
---

# Workspaces (Multi-Repo Fleet)

Workspace mode lets one `devintern worker` process serve every repository your team automates. Instead of one worker per repo, you describe your repos once in `~/.devintern/workspace.toml`, point the worker at one tracker query, and route each ready task to the right repository with explicit rules.

Workspace mode is a team-tier capability: it requires a team automation subscription (trials work too, so you can evaluate it).

## How it works

- The worker polls your tracker with one fleet-wide query (the same detect-then-evaluate loop as single-repo polling, with one cursor).
- Each ready task is matched against your routing rules. A task runs only when the rules agree on exactly one repository. The worker never guesses: tasks that match no rule, or rules for different repositories, are skipped and recorded, and are retried only after the task changes again.
- The worker manages a bare clone of each repository under `~/.devintern/repos/` and runs every task in a fresh, disposable worktree under `~/.devintern/worktrees/`. Your own checkouts are never touched. Worktrees are removed after a successful run, kept for debugging when a run fails, and swept after `worktrees_ttl_days`.
- All worker state (queue, cursors, agent PR registry, run records, routing skips) lives in one database at `~/.devintern/state/queue.db`.
- Runs are serialized: one task at a time, with a per-repository lock. One systemd unit (or one terminal) drives the whole fleet.

## workspace.toml

```toml
[workspace]
worktrees_ttl_days = 7

[defaults]
tracker = "jira"
task_query = "sprint in openSprints() AND labels = devintern"
worker_task_args = "--create-pr"
default_branch = "main"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
default_branch = "main"
# env_file = "env/backend.env"        # optional, relative to ~/.devintern
  [repos.env]                         # optional per-repo overrides
  GITHUB_REPO = "acme/backend"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"

[[routing.rules]]
repo = "backend"
project = "BACK"

[[routing.rules]]
repo = "frontend"
project = "WEB"
labels = ["frontend"]
```

- `[defaults].tracker` picks the tracker for the fleet query; any tracker with polling support works (Jira, Linear, GitHub Issues, Azure DevOps, Asana, Trello, Markdown).
- Repo names must be unique and filesystem-safe; they become directory names under `repos/` and `worktrees/`.
- Rule criteria combine with AND; list values (`components`, `labels`) match when the task carries any of them. Comparisons are case-insensitive. `project` matches the task key prefix for `PROJ-123` style keys (Jira, Linear); trackers with numeric or opaque ids route via labels or components.

## Creating a workspace

```bash
devintern workspace init      # scaffold ~/.devintern/workspace.toml and .env
cd ~/code/backend
devintern workspace import    # add this repo to the workspace
cd ~/code/frontend
devintern workspace import
```

`workspace import` reads the repo's origin remote and its `.devintern-code/.env`:

- The remote becomes a `[[repos]]` entry (name derived from the remote, unique and filesystem-safe; default branch from `origin/HEAD` when it differs from the workspace default).
- Env keys the workspace does not have yet are merged into the shared `.env`. Values that conflict with the workspace `.env` are kept repo-local in that repo's `[repos.env]`; nothing is silently overwritten.
- When the repo's env carries a default project key (Jira or Linear), a starter routing rule is seeded for it.
- Re-running import for the same repo is a no-op. Hand-written comments in `workspace.toml` are preserved; new entries are appended.
- `.devintern-code/settings.json` needs no migration: it travels with the repo and applies inside each task worktree.

## Environment

Secrets live in one shared `~/.devintern/.env` (tracker credentials, `GITHUB_TOKEN` and/or GitHub App credentials, agent settings). Each repo can layer more on top:

1. Shared workspace `.env`
2. The repo's `env_file` (if set)
3. Inline `[repos.env]` values (highest precedence)

For GitHub remotes the worker fills `GITHUB_REPO` automatically from the remote URL.

## Running

```bash
devintern worker            # auto-detects ~/.devintern/workspace.toml
devintern worker --workspace /path/to/workspace.toml
devintern worker --no-workspace   # force single-repo mode in the current repo
```

The fleet query comes from `[defaults].task_query`, or `--query` / `WORKER_TASK_QUERY` to override. `--listen` (direct webhooks) is single-repo and cannot be combined with workspace mode.

One systemd unit runs the whole fleet:

```ini
[Unit]
Description=DevIntern fleet worker
After=network-online.target

[Service]
ExecStart=/usr/local/bin/devintern worker
Restart=on-failure
User=devintern

[Install]
WantedBy=multi-user.target
```

## Multi-team workspaces

Larger organizations often run teams on completely different projects and trackers — Platform on Jira, Growth on Linear or a second Trello board. A `[[teams]]` section teaches one fleet worker to poll every board, with each team getting its own credentials, query, cursor, and routing scope. Repos, locks, the central database, and the execute path are shared.

```toml
[defaults]
worker_task_args = "--create-pr"
default_branch = "main"

[[teams]]
name = "platform"
tracker = "jira"
task_query = "project = PLAT AND labels = devintern"
env_file = "env/platform.env"        # JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN

[[teams]]
name = "growth"
tracker = "linear"
task_query = "{\"team\":{\"key\":{\"eq\":\"GROW\"}}}"
  [teams.env]                        # inline credentials also work
  LINEAR_API_KEY = "lin_api_..."

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[routing.rules]]
team = "platform"                    # rule only applies to platform's tasks
repo = "api"
project = "PLAT"

[[routing.rules]]                    # unscoped rules apply to every team
repo = "docs-site"
labels = ["docs"]
```

How teams differ from the single-defaults setup:

- **One acquirer per team.** Each team polls its own tracker with its own query and interval; a slow board never delays another team's pickup.
- **Isolated credentials.** Team env layers over the workspace `.env` (`workspace .env` < `env_file` < inline `[teams.env]`); clients are built per team without touching shared process environment, so two boards of the same tracker type stay independent.
- **Isolated cursors and dedupe.** Cursor sources are namespaced per team (`jira:platform`, `trello:growth`), so two boards of the same type never share a cursor or cross-dedupe tasks.
- **Scoped routing ("never guess").** Tasks route only against the acquiring team's rules plus unscoped rules; rules naming another team never match. Ambiguous/unrouted skips record the team alongside the task.
- **Team-aware task runs.** The subprocess that implements a task gets the team's credentials layered in and `TASK_TRACKER` pinned to the acquiring team's tracker, so status transitions hit the right board.
- **Relay.** A relayed `task.changed` event is evaluated against each team's query in order; the first team whose query matches executes it.

Rules of thumb:

- Omitting `[[teams]]` entirely keeps today's single `[defaults]` behavior — no migration needed.
- With teams present, `[defaults].tracker` and `[defaults].task_query` become optional fallbacks for teams that omit them.
- `--query` / `WORKER_TASK_QUERY` only override the single-defaults fleet query; in multi-team mode every team uses its own `task_query`.
- Team names must be unique and filesystem-safe (they namespace state). Each team needs a pollable tracker and a query.

## Reviews, mentions, and the relay

With GitHub credentials in the workspace `.env`, the fleet worker also reacts to PR activity across every GitHub repo in the workspace:

- **The agent's own PRs**: one poller watches every PR the fleet created (the registry is shared across repos) and addresses actionable review feedback automatically.
- **@mentions on any PR**: each GitHub repo gets a mention sweep. Mention-triggered runs are permission gated: the mentioning user needs write, maintain, or admin access, and the gate fails closed on API errors. Fork PRs are skipped unless maintainer edits are allowed.
- **Relay (instant events)**: set `WORKER_RELAY_URL` and `LICENSE_KEY` in the workspace `.env`. Relay envelopes carry the repository, so events route to the right repo automatically; task events re-run the fleet query and go through the same routing rules. Events for repositories not in the workspace are ignored.

Review and mention runs execute as subprocesses in the repo's persistent base checkout under `~/.devintern/worktrees/<repo>/base`, with the same layered environment as task runs.

## Skipped tasks

Ambiguous and unmatched tasks are recorded in the workspace database with the rules that matched. Fix the routing rules (or the task's labels), touch the task, and the worker picks it up on the next change. Skips never loop: a skipped task is not retried until it changes.
