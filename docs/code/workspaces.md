---
title: "Workspaces (Multi-Repo Fleet)"
description: "Drive many repositories with one devintern worker: a single workspace.toml, routing rules, per-task worktrees, and opt-in parallel execution across repos"
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
- `[workspace].parallel_across_repos` must be `true` or `false`; `[workspace].max_concurrency` must be a positive whole number (`1`, `2`, …). Invalid values fail startup with a clear message.

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

The dashboard (`devintern worker --ui` or `devintern dashboard`) shows what every configured repo is doing — `idle`, `queued`, or `running`, plus the current task key / PR and the aggregate active/max concurrency. The same data is available from `GET /api/worker`. After a crash, leftover activity rows are marked stale until the next worker start clears them.

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

## Reviews, mentions, and the relay

With GitHub credentials in the workspace `.env`, the fleet worker also reacts to PR activity across every GitHub repo in the workspace:

- **The agent's own PRs**: one poller watches every PR the fleet created (the registry is shared across repos) and addresses actionable review feedback automatically.
- **@mentions on any PR**: each GitHub repo gets a mention sweep. Mention-triggered runs are permission gated: the mentioning user needs write, maintain, or admin access, and the gate fails closed on API errors. Fork PRs are skipped unless maintainer edits are allowed.
- **Relay (instant events)**: set `WORKER_RELAY_URL` and `LICENSE_KEY` in the workspace `.env`. Relay envelopes carry the repository, so events route to the right repo automatically; task events re-run the fleet query and go through the same routing rules. Events for repositories not in the workspace are ignored.

Review and mention runs execute as subprocesses in the repo's persistent base checkout under `~/.devintern/worktrees/<repo>/base`, with the same layered environment as task runs.

## Skipped tasks

Ambiguous and unmatched tasks are recorded in the workspace database with the rules that matched. Fix the routing rules (or the task's labels), touch the task, and the worker picks it up on the next change. Skips never loop: a skipped task is not retried until it changes.
