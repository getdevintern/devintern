---
title: "Workspaces (Multi-Repo Fleet)"
description: "Drive many repositories with one devintern worker: a single workspace.toml, routing rules, per-task worktrees, and opt-in parallel execution across repos"
section: "Server Automation"
order: 1
dateModified: 2026-08-26
---

# Workspaces (Multi-Repo Fleet)

Workspace mode lets one `devintern worker` process serve every repository you automate. Instead of one worker per repo, you describe your repos once in `~/.devintern/workspace.toml`, point the worker at one tracker query, and route each ready task to the right repository with explicit rules when there is more than one repo.

The shortest path is `devintern worker init` inside a checkout: that writes a 1-repo workspace (import + `[defaults].task_query`) and you add more repos later with `devintern workspace import`.

Workspace mode runs under the same automation license as the rest of the worker: any Supporter, Team, or Business key (or an active trial) covers it — one license spans all of your own repos in the fleet.

## How it works

- The worker polls your tracker with one fleet-wide query (a detect-then-evaluate loop with one cursor).
- Each ready task is matched against your routing rules. A task runs only when the rules agree on exactly one repository. The worker never guesses: tasks that match no rule, or rules for different repositories, are skipped and recorded, and are retried only after the task changes again. **A 1-repo workspace needs no routing rules** — N=1 already implies the only checkout (`devintern worker init` starts this way).
- The worker manages a bare clone of each repository under `~/.devintern/repos/` and runs every task in a fresh, disposable worktree under `~/.devintern/worktrees/`. Your own checkouts are never touched. Worktrees are removed after a successful run, kept for debugging when a run fails, and swept after `worktrees_ttl_days`.
- All worker state (queue, cursors, agent PR registry, run records, routing skips, live fleet activity) lives in one database at `~/.devintern/state/queue.db`.
- Runs are serialized **within each repository** by a per-repo run lock. By default the whole fleet runs one task at a time; you can opt in to running different repositories concurrently (see [Parallel execution](#parallel-execution-across-repositories)).
- One systemd unit (or one terminal) drives the whole fleet.

## workspace.toml

```toml
[workspace]
worktrees_ttl_days = 7
# Opt-in concurrency across repositories (default false):
parallel_across_repos = false
max_concurrency = 4
dashboard = true
# dashboard_port = 4400

[defaults]
tracker = "jira"
task_query = "sprint in openSprints() AND labels = devintern"
worker_task_args = "--create-pr"
poll_interval = 60
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

[[automations]]
id = "backend-maintenance"
enabled = true
interval = "6h"
repo = "backend"
prompt = "Inspect the backend and implement one safe maintenance improvement."

[[automations]]
id = "weekly-frontend-cleanup"
enabled = true
cron = "0 9 * * 1"
repo = "frontend"
prompt = "Review the frontend and clean up one source of recurring noise."
```

- `[defaults].tracker` picks the tracker for the fleet query; any tracker with polling support works (Jira, Linear, GitHub Issues, Azure DevOps, Asana, Trello, Markdown).
- Repo names must be unique and filesystem-safe; they become directory names under `repos/` and `worktrees/`.
- Rule criteria combine with AND; list values (`components`, `labels`) match when the task carries any of them. Comparisons are case-insensitive. `project` matches the task key prefix for `PROJ-123` style keys (Jira, Linear); trackers with numeric or opaque ids route via labels or components.
- `[[automations]]` uses the same schema as single-repo `.devintern-code/automations.toml`. An entry must name `repo` when the workspace has more than one repository. See [Worker Daemon → Recurring automations](./worker.md#recurring-automations) for prompt-writing guidance and schedule semantics.
- `[workspace].parallel_across_repos` must be `true` or `false`; `[workspace].max_concurrency` must be a positive whole number (`1`, `2`, …). Invalid values fail startup with a clear message.

### How workspace automations differ from single-repo ones

The scheduling is identical; only where the work runs changes:

- Each occurrence runs in the repo's persistent base worktree (`~/.devintern/worktrees/<repo>/base`) with the same layered environment as review work: shared `.env` → repo `env_file` → `[repos.env]`.
- It takes the normal per-repo run lock, so it never mutates a checkout concurrently with a task or PR run.
- Occurrence task files land under the workspace home (`~/.devintern/automations/<id>/`), next to `repos/`, `worktrees/`, and the central database — not inside the repo worktrees.

## Parallel execution across repositories

By default the fleet executes one task at a time, exactly as it did before this option existed. Setting `parallel_across_repos = true` lets tasks routed to **different** repositories run at the same time:

```toml
[workspace]
parallel_across_repos = true
max_concurrency = 4   # optional; defaults to 4
```

Semantics, regardless of settings:

- **One run per repository, always.** Work for the same repo is queued and runs FIFO — never overlapping, no matter which source submitted it (task polling, relay events, PR reviews, or @mentions all join the same per-repo lane).
- **Global limit.** At most `max_concurrency` runs are in flight across the workspace. Extra ready tasks queue and start as slots free up. A cap larger than your repo count is fine — it is simply never filled.
- **Cross-process safety.** The per-repo lock file under `~/.devintern/locks/` remains the safety boundary between processes. If another process holds a repo's lock, that work is *deferred* and retried automatically (every ~10s) instead of being counted as a failed attempt — its dedupe record is not consumed, so nothing is lost while waiting.
- **Failure isolation.** A failed run in one repo does not cancel, block, or misreport concurrent runs elsewhere; failures are recorded per task as usual.
- **Safe shared state.** The central `queue.db` runs in WAL mode with a busy timeout, so concurrent runs read and write history without database-lock errors.

### Graceful shutdown

On `SIGINT`/`SIGTERM` the worker stops acquiring new events, then:

1. Queued (not yet started) tasks are cancelled **with their dedupe marks rolled back**, so the next start picks them up again automatically.
2. In-flight runs are awaited to completion so their per-repo locks are released cleanly.
3. Shared database handles are closed and the workspace lock is released.

Press `Ctrl-C` a second time to exit immediately if a run appears hung; an interrupted in-flight run is recovered by the normal incomplete-attempt machinery on the next start.

### Watching the fleet

The dashboard (`devintern worker` serves it by default per `[workspace].dashboard`, or `devintern dashboard`) shows what every configured repo is doing — `idle`, `queued`, or `running`, plus the current task key / PR and the aggregate active/max concurrency. The same data is available from `GET /api/worker`. After a crash, leftover activity rows are marked stale until the next worker start clears them.

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
```

The fleet query comes from `[defaults].task_query`. A workspace with automations can omit the query and run as an automation-only worker. Poll interval, per-task flags, and the embedded dashboard are also set in `workspace.toml` (`poll_interval`, `worker_task_args`, `[workspace].dashboard` / `dashboard_port`). Direct webhooks are an advanced repo-local service: run `devintern webhook serve` from that repository as a separate process. Workspace and automation configuration is loaded at startup; restart the worker after editing it. Schedule state and leases for automations live in the central workspace database.

`devintern worker init` can generate a user-level systemd unit on Linux or launchd agent on macOS. One service runs the whole workspace. For a hand-written Linux unit:

```ini
[Unit]
Description=DevIntern fleet worker
After=network-online.target

[Service]
ExecStart=/usr/local/bin/devintern worker
Restart=on-failure
WorkingDirectory=/home/you/.devintern

[Install]
WantedBy=multi-user.target
```

## Reviews, mentions, and the relay

With GitHub credentials in the workspace `.env`, the fleet worker also reacts to PR activity across every GitHub repo in the workspace:

- **The agent's own PRs**: one poller watches every PR the fleet created (the registry is shared across repos) and addresses actionable review feedback automatically. Entries for repos no longer in `workspace.toml` are unwatched at startup.
- **@mentions on any PR**: each GitHub repo gets a mention sweep. Mention-triggered runs are permission gated: the mentioning user needs write, maintain, or admin access, and the gate fails closed on API errors. Fork PRs are skipped unless maintainer edits are allowed.
- **Relay (instant events)**: accept relay setup in `devintern worker init`; its durable pairing is stored under the workspace home and starts automatically with the worker. Relay envelopes carry the repository, so events route to the right repo automatically; task events re-run the fleet query and go through the same routing rules. Tracker relay events work even when GitHub polling credentials are not configured. Events for repositories not in the workspace are ignored.

Review and mention runs execute as subprocesses in the repo's persistent base checkout under `~/.devintern/worktrees/<repo>/base`, with the same layered environment as task runs.

## Skipped tasks

Ambiguous and unmatched tasks are recorded in the workspace database with the rules that matched. Fix the routing rules (or the task's labels), touch the task, and the worker picks it up on the next change. Skips never loop: a skipped task is not retried until it changes.
