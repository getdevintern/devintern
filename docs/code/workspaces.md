---
title: "Workspaces (Multi-Repo Fleet)"
description: "Drive many repositories with one devintern worker: a single workspace.toml, routing rules, coordinated multi-repo tasks, and per-task worktrees"
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
- When a task matches rules for **several** repositories and those repos carry routing hints (see below), the worker instead plans a *coordinated* run across them — see [Coordinated multi-repo tasks](#coordinated-multi-repo-tasks).
- The worker manages a bare clone of each repository under `~/.devintern/repos/` and runs every task in a fresh, disposable worktree under `~/.devintern/worktrees/`. Your own checkouts are never touched. Worktrees are removed after a successful run, kept for debugging when a run fails, and swept after `worktrees_ttl_days`.
- All worker state (queue, cursors, agent PRs, run records, routing skips, coordinated efforts) lives in one database at `~/.devintern/state/queue.db`.
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
name = "shared-config"
remote = "git@github.com:acme/shared-config.git"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
default_branch = "main"
branch_prefix = "feature"           # optional branch convention (default: feature)
# env_file = "env/backend.env"      # optional, relative to ~/.devintern
  [repos.env]                       # optional per-repo overrides
  GITHUB_REPO = "acme/backend"
  [repos.hints]                     # optional routing hints for coordinated tasks
  purpose = "Core REST API service"
  domains = ["checkout", "auth"]
  capabilities = ["auth"]
  owned_paths = ["api/", "services/"]
  depends_on = ["shared-config"]

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"
  [repos.hints]
  purpose = "Web dashboard"
  depends_on = ["backend"]

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
- `[repos.hints]` and `branch_prefix` are optional. Existing workspace files without hints keep working exactly as before.

### Routing hints

Hints give the planner context about what each repository is and how they fit together:

| Key | Meaning |
| --- | --- |
| `purpose` | One-line description of what the repository is for |
| `domains` | Product areas the repo covers (e.g. `checkout`, `auth`) |
| `capabilities` | Functionality the repo provides to other repos |
| `owned_paths` | Paths the repo owns, useful when a task names files or areas |
| `depends_on` | Repositories this one depends on at code level (must match other repo names) |

Validation is strict where it protects execution: `depends_on` entries must reference configured repos (no typos) and may not be self-referential. Hints alone never change single-repo routing — they only inform coordinated planning.

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

## Coordinated multi-repo tasks

Some tasks legitimately span repositories: an API change plus the frontend that consumes it. Deterministic routing cannot express that — it either picks one repo or gives up. Coordination fills the gap.

### When coordination triggers

Coordination only kicks in where single-repo routing is *ambiguous* (rules for two or more repos match) **and** at least one of the matching repos carries `[repos.hints]`. In that case, instead of recording a skip, the worker plans a coordinated effort across the candidates:

1. The task's title and description are combined with every repo's routing hints into a planning prompt.
2. The configured agent proposes a plan: which repos are affected, why each is selected, what should change there, and which selected repos depend on which.
3. The plan is validated strictly **before anything is mutated**: unknown repo references, duplicate selections, dependencies on unselected repos, and dependency cycles are all rejected. An empty or low-confidence proposal fails safely — the task is recorded as `unplanned` in the routing skips and retried when it changes again.
4. Valid plans get a stable **coordination ID** (e.g. `dev-84-k3j2h5m9`) that links one parent effort to all per-repository runs.

### Sequencing and execution order

Repositories execute in a deterministic topological order of the plan's dependency graph (ties break alphabetically). A dependent repository does not start until its prerequisites reach the success boundary; if a prerequisite fails, its dependents are recorded as `blocked` with the reason and never run automatically. Independent repositories each run through the standard single-repository pipeline — branch, agent implementation, commit, push, PR — in their own disposable worktree, so per-run isolation and temporary-directory guarantees are unchanged.

Branch names derive from the coordination ID (`feature/<coordination-id>`, or `<branch_prefix>/<coordination-id>` when a repo sets one), making them deterministic and collision-resistant without extra coordination state.

### Pull requests

Every PR description includes a coordination section: the original task, the repository's role in the effort, its planned change, dependency context, the coordination ID, and links to all sibling PRs. Because later PRs do not exist yet when the first one is created, the section initially marks siblings as *(PR pending)* and a final reconciliation step rewrites every description once all PR URLs are known. Reconciliation failures are recoverable coordination errors — retry them without touching implementation with:

```bash
devintern workspace reconcile <coordination-id>
```

### Resume and failure behavior

All plan and run-state transitions persist immediately in the workspace database (`coordinations` and `coordination_runs` tables, plus a `coordination_id` column on the shared `runs` records):

- Completed repositories are never recreated on resume — branches, commits, pushes, and PRs already recorded as succeeded are skipped verbatim.
- Failed or blocked repositories retry when the task changes again (the same trigger that resumes any interrupted effort).
- Pushes and PR creations that succeeded are recorded at the moment they happen, so retries stay idempotent even after a crash mid-fleet.
- A failed repository blocks only its dependents; successful prerequisite work is preserved and existing PRs are never closed or deleted.

A partially completed effort shows up as resumable (`partial_failure`) until every planned repository has reached a terminal state.

## Observing coordinated efforts

The dashboard groups each coordinated effort under one parent run record. Per repository you can see the selection rationale, status (`pending`, `in_progress`, `succeeded`, `failed`, `skipped`, `blocked`), derived dependency state, branch, and PR URL.

API example:

```bash
# All coordinated efforts (most recent first)
curl -s localhost:4400/api/coordination | jq .

# One effort with its per-repository runs
curl -s localhost:4400/api/coordination/dev-84-k3j2h5m9 | jq .

# Runs grouped by effort
curl -s 'localhost:4400/api/runs?coordinationId=dev-84-k3j2h5m9' | jq .
```

```json
{
  "coordinationId": "dev-84-k3j2h5m9",
  "taskKey": "DEV-84",
  "status": "partial_failure",
  "runs": [
    {
      "repo": "shared-config",
      "status": "succeeded",
      "dependencyState": "none",
      "branch": "feature/dev-84-k3j2h5m9",
      "prUrl": "https://github.com/acme/shared-config/pull/18"
    },
    {
      "repo": "backend",
      "status": "blocked",
      "dependencyState": "blocked",
      "branch": "task/dev-84-k3j2h5m9",
      "reason": "prerequisite \"shared-config\" did not succeed"
    }
  ]
}
```

## Skipped tasks

Ambiguous and unmatched tasks are recorded in the workspace database with the rules that matched. Fix the routing rules (or the task's labels), touch the task, and the worker picks it up on the next change. Skips never loop: a skipped task is not retried until it changes. Tasks that matched multiple hinted repos but produced no valid coordinated plan are recorded with reason `unplanned`.
