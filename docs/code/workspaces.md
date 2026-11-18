---
title: "Workspaces (Multi-Repo Fleet)"
sidebarLabel: "Multiple Repositories"
description: "Use when one worker should serve several repositories or tracker teams: workspace.toml, routing rules, and isolated per-task worktrees."
section: "Automation"
order: 3
dateModified: 2026-11-18
---

# Workspaces (Multi-Repo Fleet)

A workspace lets one `devintern worker` serve every repository you automate. You describe the repositories once in `~/.devintern/workspace.toml`, then poll either one default tracker query or several separate tracker teams. One automation license covers the whole workspace.

`devintern worker init` inside a checkout writes a one-repo workspace. Add more later:

```bash
devintern worker scaffold        # create ~/.devintern/workspace.toml and .env
cd ~/code/backend && devintern worker add-repo
cd ~/code/frontend && devintern worker add-repo
```

`worker add-repo` adds a `[[repos]]` entry from the checkout's `origin` remote, merges new keys from its `.devintern-code/.env` into the shared `.env` (conflicting values go to that repo's `[repos.env]`), and seeds a routing rule for a Jira or Linear project key. Running it again is a no-op, and comments in `workspace.toml` are preserved. The repo's `.devintern-code/settings.json` needs no changes.

## How it works

- The worker keeps a bare clone of each repository under `~/.devintern/repos/` and runs each task in a fresh worktree under `~/.devintern/worktrees/`. Your own checkouts are never touched.
- Before the agent starts, dependencies are installed by detecting the package manager from the lockfile. If that fails, the run continues with a warning.
- Worktrees are removed after a successful run and kept after a failure for debugging, then deleted after `worktrees_ttl_days`.
- Runs, queue, and schedule state live in `~/.devintern/state/queue.db`. Worker sign-in and relay pairing live in `~/.devintern/state/code/`; use `devintern worker login` to sign in.

## The workspace file

A short example with two repositories and one tracker query:

```toml
[workspace]
worktrees_ttl_days = 7          # delete kept worktrees after this many days
dashboard = true                # embedded dashboard on dashboard_port (default 4400)

[defaults]
tracker = "jira"
task_query = "sprint in openSprints() AND labels = devintern"
worker_task_args = "--create-pr"  # flags for every task run
poll_interval = 60                # seconds
pr_labels = ["devintern"]         # GitHub only

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
default_branch = "main"         # optional; default is the remote's HEAD
env_file = "env/backend.env"    # optional, relative to ~/.devintern
  [repos.env]
  GITHUB_REPO = "acme/backend"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"

[[routing.rules]]
repo = "backend"
project = "BACK"

[[routing.rules]]
repo = "frontend"
labels = ["frontend"]
```

Keys not shown here are documented on the page for their feature:

| Keys                                                                                                     | Page                                                                               |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `[[automations]]`                                                                                        | [Recurring Automations](./automations.md)                                          |
| `[[estimations]]`                                                                                        | [Story Points Estimation](./story-points-estimation.md#scheduled-estimation-with-the-worker) |
| `[[error_monitors]]`                                                                                     | [Sentry Auto-fixes](./sentry-integration.md)                                       |
| `[workspace].conflict_resolution*`, `auto_merge*`, `ci_failure_fix`; `[[repos]].sync_team_prs`, `auto_merge_safe_paths`, `auto_merge_deny_paths` | [PR Follow-up](./pr-follow-up.md)                     |
| `[worker.schedule]`, `[worker].auto_update`, `[workspace].dashboard_port`                                | [Worker Daemon](./worker.md)                                                       |
| `[dashboard].allowed_origins`, `tailscale_autodetect`                                                    | [Dashboard](./dashboard.md#allowed-origins)                                        |
| `pipeline_file`                                                                                          | [below](#pipelines-for-the-fleet-and-per-repository)                               |

Notes on the keys above:

- `[defaults].tracker` can be any tracker with polling support.
- A repo's `pr_labels` replaces `[defaults].pr_labels`. Outside a workspace, set `PR_LABELS` (comma-separated) in `.devintern-code/.env`.
- Repo names must be unique and filesystem-safe; they become directory names.

## Routing tasks to repositories

A one-repo workspace needs no routing rules. With several repositories, each task must match rules that agree on exactly one repo. Tasks that match none, or match rules naming different repos, are recorded as skipped and not run; fix the rules or the task's labels, then edit the task.

| Rule key     | Matches                                                         |
| ------------ | --------------------------------------------------------------- |
| `repo`       | Target repository (required)                                    |
| `project`    | Key prefix for `PROJ-123` style keys (Jira, Linear)            |
| `labels`     | Any of the listed labels                                        |
| `components` | Any of the listed components                                    |
| `team`       | Limits the rule to one [team](#multiple-teams-and-tracker-boards) |

Criteria in one rule are ANDed, and comparisons are case-insensitive. Trackers with numeric ids route by labels or components.

## Multiple teams and tracker boards

Use `[[teams]]` when one worker polls separate boards, tracker accounts, or tracker products. Each team has its own query, polling state, and credentials:

```toml
[[teams]]
name = "platform"
tracker = "jira"
task_query = "project = PLAT AND labels = devintern"
repo = "api"                    # every task from this team runs in api
env_file = "env/platform.env"

[[teams]]
name = "growth"
tracker = "linear"
task_query = '{"team":{"key":{"eq":"GROW"}}}'
  [teams.env]
  LINEAR_API_KEY = "lin_api_..."

[[routing.rules]]
team = "growth"
repo = "web"
labels = ["web"]
```

- A team with `repo` sends every task to that repository and ignores routing rules. It cannot also have team-scoped rules.
- A team without `repo` uses rules that name it plus rules with no `team`. It needs at least one applicable rule in a multi-repo workspace.
- Credentials layer as workspace `.env`, then the team's `env_file`, then `[teams.env]`. The shared `.env` can also hold team-specific values named `<TRACKER>_<TEAM>_<SETTING>`, for example `JIRA_PLATFORM_API_TOKEN`. The team name is uppercased, and characters other than letters and digits become `_`.
- Once any team exists, `[defaults].task_query` is no longer polled on its own. A workspace with only automations, estimations, or Sentry monitors needs no task query at all.
- Connect each team to the [relay](./relay.md) separately: `devintern worker connect jira --team platform`.

## Pipelines for the fleet and per repository

Set `pipeline_file` to a JSON pipeline definition (same schema as the `pipeline` block in `settings.json`) for the whole fleet in `[defaults]`, or for one repo in `[[repos]]`. Paths resolve against `~/.devintern`.

```toml
[defaults]
pipeline_file = "pipelines/default.json"   # fleet-wide

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
pipeline_file = "pipelines/backend.json"   # this repo only
```

Exactly one pipeline runs per task, chosen in this order: the repo's `pipeline_file`, the repository's checked-in `.devintern-code/settings.json` pipeline, `[defaults].pipeline_file`, then the built-in default. Relative plugin and prompt paths in a `pipeline_file` resolve against that file's directory, so install plugin dependencies there. An invalid pipeline fails the run with the file named. See [Customizing the Task Pipeline](./pipelines.md) for steps and plugins.

## Bounded host concurrency

By default the worker runs one agent job at a time. To run independent jobs in parallel, opt in explicitly:

```toml
[workspace.execution]
isolation = "best_effort_host"
max_concurrency = 4              # all agent jobs across the workspace
max_concurrency_per_repo = 1     # task worktrees per repository
```

Raising either limit above 1 requires `isolation = "best_effort_host"`. This is **not an isolation boundary**: parallel jobs share the host's ports, processes, Docker daemon, caches, and agent quota, which can cause `EADDRINUSE`, port conflicts, and lock errors. Use it only for repositories whose tasks tolerate that. Reviews and CI fixes stay serialized per repository, and short PR jobs get slots before tasks.

## Environment

Secrets live in one owner-only `~/.devintern/.env`: tracker credentials, `GITHUB_TOKEN`, and agent settings. The worker does not read a checkout's `.devintern-code/.env`. Each repository can layer more on top, highest last:

1. Shared workspace `.env`
2. The repo's `env_file`
3. Inline `[repos.env]` values

For GitHub remotes, `GITHUB_REPO` is filled in from the remote URL. For GitLab remotes on your tracker instance, `GITLAB_PROJECT` is filled in with the project path (`group/sub/repo`): `gitlab.com` remotes while `GITLAB_BASE_URL` is unset or `gitlab.com`, and self-managed remotes when their host (or a `GITLAB_CODE_HOST_ALIASES` alias) matches `GITLAB_BASE_URL`. A `GITHUB_REPO` or `GITLAB_PROJECT` you set in any layer, including a team's, wins over the derived value. Polling and issue search still use the workspace or team `GITLAB_PROJECT`, so keep a centralized tracker project in the shared `.env`. GitHub API calls for a repo use that repo's `GITHUB_TOKEN` layers, or a fixed team's credentials when one targets the repo. Artifact upload settings (`DEVINTERN_ARTIFACT_*`) use the same layers; see [upload configuration](./artifacts.md#files-sdk-uploader).

Other trackers have no repo-to-project mapping, so set per-repo keys such as `JIRA_DEFAULT_PROJECT_KEY`, `LINEAR_DEFAULT_TEAM_KEY`, `ASANA_DEFAULT_PROJECT_GID`, `AZURE_DEVOPS_PROJECT`, or `TRELLO_DEFAULT_BOARD_ID` in the repo's `env_file` or `[repos.env]`.

## Editing the config while running

The worker reloads `workspace.toml` a moment after you save it. Work already running finishes with the old config. Send `SIGHUP` to force a reload. A broken edit is logged and the last valid config keeps running.

Most settings apply on reload, including repos, routing rules, queries, team `repo`, automations, estimations, pipelines, concurrency, and PR follow-up settings. These need a restart:

- team `name`, `tracker`, `env_file`, and `[teams.env]`
- `[[error_monitors]]`
- `[defaults].tracker` and tracker credentials in the workspace `.env`
- `[worker.schedule]`
- `[workspace].dashboard` and `dashboard_port`

A reload that changes a restart-only setting is rejected as a whole.
