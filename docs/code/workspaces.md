---
title: "Workspaces (Multi-Repo Fleet)"
sidebarLabel: "Multiple Repositories"
description: "Drive repositories and tracker teams with one devintern worker: workspace.toml routing and isolated per-task worktrees"
section: "Automation"
order: 2
dateModified: 2026-09-03
---

# Workspaces (Multi-Repo Fleet)

Workspace mode lets one `devintern worker` process serve every repository you automate. Instead of one worker per repo, you describe repositories once in `~/.devintern/workspace.toml`, then use either one default tracker query or several isolated team tracker sources.

The shortest path is `devintern worker init` inside a checkout: that writes a 1-repo workspace (add + `[defaults].task_query`) and you add more repos later with `devintern worker add-repo`.

Workspace mode runs under the same automation license as the rest of the worker: any Supporter, Team, or Business key (or an active trial) covers it — one license spans all of your own repos in the fleet.

## How it works

- Without `[[teams]]`, the worker polls `[defaults].task_query`. With teams, it creates one isolated tracker client, query, cursor, and dedupe scope per team.
- A team can set `repo` for a fixed destination. A team spanning repositories omits `repo` and uses routing rules. A task runs only when its applicable rules agree on one repository; unmatched or ambiguous work is recorded rather than guessed. **A 1-repo workspace needs no routing rules** — N=1 already implies the only checkout (`devintern worker init` starts this way).
- The worker manages a bare clone of each repository under `~/.devintern/repos/` and runs every task in a fresh, disposable worktree under `~/.devintern/worktrees/`. Your own checkouts are never touched. Worktrees are removed after a successful run, kept for debugging when a run fails, and swept after `worktrees_ttl_days` — at worker startup and then hourly while the worker runs.
- All worker state (queue, cursors, agent PR registry, run records, routing skips) lives in one database at `~/.devintern/state/queue.db`.
- Runs are serialized: one task at a time, with a per-repository lock. One systemd unit (or one terminal) drives the whole fleet.

## workspace.toml

```toml
[workspace]
worktrees_ttl_days = 7
dashboard = true
# dashboard_port = 4400
# Batch automatic conflict resolution off-peak instead of instant (default "auto"):
# conflict_resolution = "scheduled"
# conflict_resolution_cron = "0 3 * * *"      # worker host timezone
# conflict_resolution_interval = "1d"         # exactly one of cron / interval
# Or turn it off entirely: conflict_resolution = "disabled"

[defaults]
tracker = "jira"
task_query = "sprint in openSprints() AND labels = devintern"
worker_task_args = "--create-pr"
poll_interval = 60
default_branch = "main"
# pr_labels = ["devintern", "auto-pr"]

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
default_branch = "main"
# pr_labels = ["backend"]
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

[worker.schedule]
active = ["22:00-06:00"]     # optional quiet hours: drain new tasks only at night
blocked = []                 # subtract from active windows (conflicts resolve to quiet)
timezone = ""                # blank = worker machine's local time
catch_up_missed = true

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

- `[defaults].tracker` picks the tracker for the single-source fleet query; any tracker with polling support works (Jira, Linear, GitHub Issues, GitLab Issues, Azure DevOps, Asana, Trello, Markdown).
- `pr_labels` applies labels to every PR the fleet creates (GitHub only). A repo's `pr_labels` overrides `[defaults].pr_labels`. Outside a workspace, single-repo users get the same behavior by setting `PR_LABELS` (comma-separated) in `.devintern-code/.env`.
- Repo names must be unique and filesystem-safe; they become directory names under `repos/` and `worktrees/`.
- Rule criteria combine with AND; list values (`components`, `labels`) match when the task carries any of them. Comparisons are case-insensitive. `project` matches the task key prefix for `PROJ-123` style keys (Jira, Linear); trackers with numeric or opaque ids route via labels or components.
- `[worker.schedule]` gates only new-task pickup: multiple windows union, windows may cross midnight, `blocked` wins on overlap, and a missed whole window triggers one catch-up drain at startup. Timezone/DST semantics and `devintern worker run-now` are covered in [Running the Worker Unattended: Working windows](./automated-task-processing.md#working-windows-quiet-hours).
- `[[automations]]` uses the same schema as single-repo `.devintern-code/automations.toml`. An entry must name `repo` when the workspace has more than one repository. See [Worker Daemon → Recurring automations](./worker.md#recurring-automations) for prompt-writing guidance and schedule semantics.
- `[[estimations]]` schedules unattended story-point sweeps (tracker query + cron/interval, no `prompt`, no `repo`). The workspace tracker must support estimation. See [Worker Daemon → Scheduled story-point estimation](./worker.md#scheduled-story-point-estimation).

### Multiple teams and tracker boards

Use `[[teams]]` when one worker must poll separate boards, tracker accounts, or tracker products. Each team has a stable name, tracker, query, and optional credential layers:

```toml
[[teams]]
name = "platform"
tracker = "jira"
task_query = "project = PLAT AND labels = devintern"
repo = "api"
env_file = "env/platform.env"

[[teams]]
name = "growth"
tracker = "linear"
task_query = '{"team":{"key":{"eq":"GROW"}}}'
repo = "web"
  [teams.env]
  LINEAR_API_KEY = "lin_api_..."
```

`repo` is a fixed mapping: every task acquired from that team runs in that repository, regardless of task labels or key shape. This is the simplest and safest setup when a tracker board belongs to one codebase. The named repository must exist in `[[repos]]`. A fixed team cannot also have team-scoped routing rules, because two competing routing models would make precedence unclear.

When one team owns several repositories, omit `repo` and add rules scoped to the team:

```toml
[[teams]]
name = "platform"
tracker = "jira"
task_query = "project in (PLAT, SRE) AND labels = devintern"
env_file = "env/platform.env"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "infra"
remote = "git@github.com:acme/infra.git"

[[routing.rules]]
team = "platform"
repo = "api"
project = "PLAT"

[[routing.rules]]
team = "platform"
repo = "infra"
project = "SRE"

[[routing.rules]]
repo = "infra"
labels = ["infrastructure"] # unscoped: available to every non-fixed team
```

Team routing follows these rules:

- Rules naming another team are invisible. Rules naming the acquiring team and rules without `team` are applicable.
- Set criteria are ANDed; lists are any-of. If applicable matches disagree on the repository, the task is recorded as ambiguous and not run.
- An unfixed team in a multi-repo workspace must have at least one applicable rule. Tasks that match none are recorded as unrouted.
- Fixed teams ignore unscoped routing rules and always use their configured `repo`.
- In a one-repo workspace, omitting both `team.repo` and routing rules still selects the only repository.

Credentials layer as workspace `.env` < team `env_file` < inline `[teams.env]` for tracker clients. Task subprocesses retain repository settings and then apply the acquiring team's credential layers, with `TASK_TRACKER` pinned to that team's tracker so comments and transitions go back to the correct board. Team cursor keys use `tracker:team` (for example `jira:platform`), so separate boards of the same tracker never share polling cursors or dedupe records.

`[defaults].tracker` and `[defaults].task_query` are optional fallbacks for team entries. Once any `[[teams]]` exist, there is no separate defaults poller. Scheduled estimations still use `[defaults].tracker`; configure it explicitly when using `[[estimations]]`.

Team `task_query` and `repo` changes live-reload along with routing rules. Team names, tracker types, `env_file`, and inline credentials are startup-only because changing them requires rebuilding tracker clients and detectors; restart the worker after changing those fields.

Tracker relay envelopes currently identify the tracker type, not an individual team registration. Instant tracker relay is therefore enabled only when one workspace team uses that tracker type. If two teams use Jira (or any same tracker), polling remains fully isolated and supported, but `worker connect jira` refuses the ambiguous relay registration and task envelopes for that tracker fail closed to polling. GitHub repository relay remains unaffected.

### Automatic conflict resolution: `auto` vs `scheduled` vs `disabled`

When a watched PR conflicts with its base branch, the worker normally resolves it right away (`conflict_resolution = "auto"`, the default — no behavior change on upgrade). Every resolution hands the conflicted files to the AI agent, which consumes tokens — even at 3am when nobody is reviewing the PR anyway.

Set `conflict_resolution = "scheduled"` to batch those resolutions into an off-peak window. Polling still detects every conflict immediately and queues it (the PR stays conflicted until then, and the worker logs which mode is active at startup); the agent only runs inside the window:

```toml
[workspace]
conflict_resolution = "scheduled"
conflict_resolution_cron = "0 3 * * *"   # or conflict_resolution_interval = "1d"
```

The schedule uses the same format as `[[automations]]`: a five-field cron expression (worker host timezone) or a positive `15m`/`6h`/`1d` interval — exactly one of the two. Exactly one window pass runs per occurrence; if the worker is down when the window arrives (a missed nightly run), the queued conflicts resolve on the first tick after restart. Inside a window the usual safety rules still apply: failed attempts wait out their retry backoff, PRs whose head is still moving wait out the quiet period, and anything not finished before the window closes (60 minutes by default, `WORKER_RESOLVE_WINDOW_GRACE_MINUTES`) waits for the next one. PRs merged upstream before the window opens are skipped — the worker re-checks GitHub's mergeability before invoking the agent.

Two things are never delayed by scheduled mode: review feedback on the agent's PRs is addressed immediately as usual, and you can always run `devintern resolve-conflicts <pr-url>` by hand to fix one PR without waiting for the window — once GitHub reports the PR conflict-free, the queued event never triggers an agent run.

The setting is workspace-wide (per-repo overrides are not supported in v1) and live-reloads with the rest of the runtime configuration. The tradeoff to keep in mind: between windows a conflicted PR cannot be merged, so on fast-moving branches where an instant rebase unblocks a waiting reviewer, `auto` stays the better choice. See [Worker Daemon → Merge conflicts on the agent's PRs](./worker.md#merge-conflicts-on-the-agents-prs) for how resolution itself works.

Set `conflict_resolution = "disabled"` to turn automatic conflict resolution off entirely: the worker stops watching for conflicts on the agent's PRs altogether — no detection, no queuing, no agent runs. A PR that conflicts with its base simply stays conflicted until someone resolves it (by hand, or on demand via `devintern resolve-conflicts <pr-url>`). Review feedback and @mention handling are unaffected. This is a valid choice when the team prefers to rebase manually, or when the agent is not trusted to resolve conflicts in a sensitive repository.

### How workspace automations differ from single-repo ones

The scheduling is identical; only where the work runs changes:

- Each occurrence runs in the repo's persistent base worktree (`~/.devintern/worktrees/<repo>/base`) with the same layered environment as review work: shared `.env` → repo `env_file` → `[repos.env]`.
- It takes the normal per-repo run lock, so it never mutates a checkout concurrently with a task or PR run.
- Occurrence task files land under the workspace home (`~/.devintern/automations/<id>/`), next to `repos/`, `worktrees/`, and the central database — not inside the repo worktrees.

## Creating a workspace

```bash
devintern worker scaffold     # scaffold ~/.devintern/workspace.toml and .env
cd ~/code/backend
devintern worker add-repo     # add this repo to the workspace
cd ~/code/frontend
devintern worker add-repo
```

`worker add-repo` reads the repo's origin remote and its `.devintern-code/.env`:

- The remote becomes a `[[repos]]` entry (name derived from the remote, unique and filesystem-safe; default branch from `origin/HEAD` when it differs from the workspace default).
- Env keys the workspace does not have yet are merged into the shared `.env`. Values that conflict with the workspace `.env` are kept repo-local in that repo's `[repos.env]`; nothing is silently overwritten.
- When the repo's env carries a default project key (Jira or Linear), a starter routing rule is seeded for it.
- Re-running `add-repo` for the same repo is a no-op. Hand-written comments in `workspace.toml` are preserved; new entries are appended.
- `.devintern-code/settings.json` needs no migration: it travels with the repo and applies inside each task worktree.

## Environment

Secrets live in one shared `~/.devintern/.env` (tracker credentials, `GITHUB_TOKEN`, agent settings). Advanced no-relay installations may also keep customer-owned GitHub App credentials there. Each repo can layer more on top:

1. Shared workspace `.env`
2. The repo's `env_file` (if set)
3. Inline `[repos.env]` values (highest precedence)

For GitHub remotes the worker fills `GITHUB_REPO` automatically from the remote URL.

## Running

```bash
devintern worker            # auto-detects ~/.devintern/workspace.toml
devintern worker --workspace /path/to/workspace.toml
```

The single-source fleet query comes from `[defaults].task_query`; multi-team workspaces use each team's `task_query`. A workspace with automations or estimations can omit the defaults query and run as a schedules-only worker. Poll interval, per-task flags, and the embedded dashboard are also set in `workspace.toml` (`poll_interval`, `worker_task_args`, `[worker.schedule]` quiet hours, `[workspace].dashboard` / `dashboard_port`). Direct webhooks are an advanced repo-local service: run `devintern webhook serve` from that repository as a separate process. Automation and estimation schedule state and leases, plus the task-polling timestamp used for missed-window catch-up, live in the central workspace database.

While the daemon is running you can request one immediate drain (for example while quiet hours are closed) with `devintern worker run-now`; see [Working windows](./automated-task-processing.md#working-windows-quiet-hours).

### Editing workspace.toml while running

The worker watches `workspace.toml` and reloads it automatically a moment after you save — no restart, and no missed tracker events or relay messages during the bounce:

- **Routing rules, repos, defaults/team `task_query`, team `repo`, `[[automations]]`, `[[estimations]]`, `worker_task_args`, `poll_interval`, `worktrees_ttl_days`, and conflict-resolution mode/schedules apply to subsequent work.** Runs already in progress finish under the configuration they started with; everything picked up afterwards uses the new one. Changing a repo's `remote` updates its managed bare clone the next time that repo is prepared.
- **Team identity and credentials are startup-only.** Restart after changing a team's name, tracker, `env_file`, or inline `[teams.env]` values.
- **A broken edit never takes the daemon down.** The reload validates the file first; parse or schema errors are logged (naming the offending entries) and the last valid configuration keeps serving until you fix it. Rewriting identical content is ignored.
- **Manual fallback:** send SIGHUP (`kill -HUP <pid>`) to force an immediate reload if file watching is unavailable on your system.
- **Startup-only settings** still require a restart: tracker credentials in the workspace `.env` and `[defaults].tracker` (the tracker client and its detector are built once), `[worker.schedule]` quiet hours (the working-window gate is built once at startup), plus `[workspace].dashboard` / `dashboard_port`. A reload that changes one of these settings is rejected in full, so the active config remains internally consistent.

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
- **@mentions on any PR**: each GitHub repo gets a mention sweep. Mention-triggered runs are permission gated: the mentioning user needs write, maintain, or admin access, and the gate fails closed on API errors. Fork PRs are skipped unless maintainer edits are allowed. Standard workspaces recognize the central `devintern-ai` identity through the relay and use `GITHUB_TOKEN` for local API calls. No-relay installations need an advanced customer-owned App.
- **Relay (instant events)**: accept relay setup in `devintern worker init`; its durable pairing is stored under the workspace home and starts automatically with the worker. GitHub envelopes carry the repository and route directly. Tracker events re-run the applicable defaults/team query and then use the same fixed mapping or routing rules as polling. A tracker type used by several teams stays polling-only because current relay envelopes do not identify the team registration; the worker fails closed instead of guessing. Events for repositories not in the workspace are ignored.

To reconnect after adding repositories, run `devintern worker connect`. The command walks every GitHub repository in `workspace.toml`, skips already verified App pairings, and guides you through verification for the rest. `devintern worker connect status` also reports workspace repositories that still need verification. Tracker targets such as `devintern worker connect linear --team growth` compose the selected team's credentials on top of the shared workspace `.env`.

Review and mention runs execute as subprocesses in the repo's persistent base checkout under `~/.devintern/worktrees/<repo>/base`, with the same layered environment as task runs.

## Skipped tasks

Ambiguous and unmatched tasks are recorded in the workspace database with the rules that matched. Fix the routing rules (or the task's labels), touch the task, and the worker picks it up on the next change. Skips never loop: a skipped task is not retried until it changes.
