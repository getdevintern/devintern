---
title: "Worker Daemon"
description: "Run devintern as a single long-running worker that reacts to PR reviews and tracker changes"
section: "Server Automation"
order: 0
dateModified: 2026-08-26
---

# Worker Daemon

`devintern worker` runs devintern as a single long-running workspace daemon on your own machine. It acquires events for every configured repository and executes them locally.

Your code, credentials, and agent execution never leave your machine.

## Quick Start

The fastest way to set up the worker is the guided setup:

```bash
devintern worker init
devintern worker
```

`worker init` reuses tracker config from `devintern init` (or runs that subset if missing), writes a 1-repo [workspace](./workspaces.md), validates and stores the ready-tasks query, checks any automation license (Supporter or Team/Business), offers zero-port relay setup, and can generate a native user service for Linux or macOS. Polling is always on. The repo-local direct webhook server is an advanced, separate service and is not part of this wizard.

Or configure by hand and start directly:

```bash
# After a workspace exists (worker init, or workspace init + import)
devintern worker

# Advanced: run the repo-local GitHub webhook listener separately
devintern webhook serve
```

## Recurring automations

Put recurring work in `workspace.toml`. Set `repo` when the workspace has multiple repositories; it is optional for a one-repo workspace:

```toml
[[automations]]
id = "dependency-health"
enabled = true
repo = "web-app"
interval = "6h"
prompt = """Pick one outdated dependency and upgrade it within the same major version.
Run the test suite; if anything breaks, revert the upgrade instead of fixing forward."""

[[automations]]
id = "flaky-test-triage"
enabled = true
repo = "web-app"
cron = "0 9 * * 1"
prompt = """Re-run the test suite twice and look for flaky tests.
For each flaky test, add a short comment explaining the suspected race condition.
Do not change production code."""
```

Every entry needs a stable unique `id`, boolean `enabled`, non-empty `prompt`, and exactly one schedule. Intervals use positive minutes, hours, or days (`15m`, `6h`, `1d`). Cron expressions have five fields and use the worker host's timezone in v1; persisted occurrence times are UTC.

Configuration is validated as a group at worker startup and changes require a restart. Automations are a valid event source, so `devintern worker` stays running without a task query when at least one automation entry is configured (disabled entries are validated but not scheduled).

### What an automation is

Automations are independent of your task tracker: **the prompt is the task**. Each occurrence writes the prompt to a local markdown task file and feeds it through exactly the same pipeline as any other task — clarity check, planning, implementation, commit, PR creation, auto-review, run records. Nothing is created in your tracker, so no tracker credentials are needed for automation-only workers.

Concretely, each occurrence:

1. Writes `~/.devintern/automations/<id>/<timestamp>.md` (or the equivalent under `DEVINTERN_WORKSPACE_DIR`).
2. Spawns the normal CLI on that file as a subprocess, so the run gets its own branch, commits, and — by default — a pull request.
3. Records the attempt with the `scheduled` origin and the automation id, so you can filter scheduled runs in the [dashboard](./dashboard.md).

Because the occurrence is just a markdown task, you can reproduce or rerun any occurrence by hand:

```bash
devintern ~/.devintern/automations/dependency-health/2026-08-24T09-00-00-000Z.md
```

### Writing good prompts

The prompt replaces the ticket description the agent would normally read, so treat it like you would write a task for a new teammate:

- **Scope it to one change per run.** "Apply one safe improvement" produces reviewable PRs; "clean up the repository" produces sprawling ones.
- **State the guardrails.** What not to touch, when to stop, what must pass (`Run the test suite before committing`).
- **Say what done means.** The pipeline's incomplete-detection reads the agent output; concrete success criteria make escalations rare.
- Prefer recurring maintenance work (dependency bumps within a major, flaky-test triage, changelog refreshes, TODO sweeps) over open-ended feature work.

### Tuning how occurrences run

Occurrences use the same flag defaults as polled tasks: `[defaults].worker_task_args` in `workspace.toml` (default `--create-pr`). For example, set `worker_task_args = "--create-pr --auto-review"` to have every automated PR go through the review loop too. This setting applies to polled tracker tasks as well.

### Schedule semantics

Schedule cursors and claims live in `queue.db`. Missed occurrences coalesce to at most one immediate run after startup. The occurrence cursor advances atomically when claimed, so a crash does not replay a possibly completed run. Active claims receive heartbeats; after two minutes without a heartbeat a later due occurrence may recover the stale claim. If the same automation is still active at its next occurrence, that occurrence is logged and skipped without creating a run record. If the repository lock is held by another task, the occurrence is also skipped. This is an at-most-once policy: skipped occurrences are not replayed.

On shutdown the scheduler stops its timer, terminates active automation subprocess groups, waits for them to exit, and leaves their claims recoverable in SQLite.

### Troubleshooting

| Symptom | Likely cause |
| ---------------------------- | ------------------------------------------------------------ |
| No occurrences fire after editing the TOML | Config is loaded at startup — restart the worker. Startup validation errors name the offending entry. |
| `occurrence skipped: previous run is active` | The previous occurrence still runs (or its lease is stale). Long prompts may simply need a longer schedule. |
| `occurrence skipped: repository is busy` | Another task holds the repo run lock; the next occurrence will retry. |
| Scheduled runs missing from the dashboard | Filter the run list by origin `scheduled`; check the worker has an automation license (startup log). |
| Task files pile up under `~/.devintern/automations/` | They are small and safe to delete — they are only run inputs; the durable record is the run history in `queue.db`. |

## Polling mode

With `[defaults].task_query` in `workspace.toml`, the worker polls your tracker on an interval (`[defaults].poll_interval`, default 60 seconds) and runs every task that matches the query. The query uses the same language as batch `--query` runs for your tracker, so "ready" means whatever your query says, for example a status or label.

How a poll cycle works:

1. A cheap change detector asks the tracker "did anything change since the last cursor?" and nothing else.
2. Only when something changed, the worker re-runs your query to get the tasks that are actually ready.
3. Each ready task is picked up once per change: the worker remembers the task's last seen update stamp, so a task re-enters only when it is updated again.
4. Tasks run one at a time through the normal pipeline (branch, implementation, PR, tracker updates), with `[defaults].worker_task_args` controlling the flags (default `--create-pr`).

Cursors persist in `.devintern-code/queue.db`; after a restart the worker resumes where it left off instead of starting from "now".

Polling is available for all seven trackers: Jira, Linear, GitHub Issues, Azure DevOps, Asana, Trello, and markdown. Trello polling uses the board actions feed and requires `TRELLO_DEFAULT_BOARD_ID`; Asana polling uses the Events API and requires `ASANA_DEFAULT_PROJECT_GID`. A folder of markdown tasks is the fastest way to try the worker: no tracker account needed. Point `[defaults].tracker` at `markdown`, set `MARKDOWN_TASKS_DIR` in the workspace `.env`, and put the ready-tasks filter in `[defaults].task_query`.

### Re-running a task

When a run cannot finish, devintern posts an "Implementation Incomplete" comment on the ticket (crash, interrupt, and failed-feasibility comments do the same) and moves it back to your to-do status. That comment tells you how to unlock a retry. The next pickup is gated so an unchanged ticket is not retried in a loop; you unlock a retry by changing the ticket:

- **Edit the description** with more detail, or
- **Post any comment** on the ticket (a one-line clarification is enough), or
- **Delete the bot's incomplete comment** from the ticket.

Either action bumps the ticket's update stamp, so the worker picks it up on the next change detection and the retry runs. On a retry the agent is told which attempt this is, why the previous attempt stopped, and which comments are new since then, so new guidance takes priority. Each attempt gets its own branch (`feature/{key}`, then `feature/{key}-attempt-2`, and so on).

If a run completes but you want a different result, move the ticket back to your to-do status (optionally with a comment describing what to change) and it re-runs the same way.

Retry bookkeeping lives in `.devintern-code/queue.db` next to the worker's cursors. For local one-off runs, `devintern TASK-123 --force` re-runs a task even if nothing on the ticket changed; do not put `--force` in `[defaults].worker_task_args`, since that would disable the gate for every polled task.

### Ticket matches the query but is not picked up

The worker log is the diagnostic. Look for `[poll:<tracker>]` (for Jira, `[poll:jira]`):

- `📌 picking up KEY` — it was claimed on this tick.
- `⏳ KEY deferred; will retry next poll` — the target repository was busy, so the task was not attempted and its claim remains pending automatically.
- `⏭️ skipping KEY (already processed at this update)` — this ticket was already claimed at this version. Edit or comment on it so its update stamp changes, then wait for the next change detection.
- `have no update stamp from the tracker` — search results are missing `updated`, so the worker cannot tell versions apart and will not retry after the first attempt. Restarting the worker does not help; a one-off `devintern KEY` still runs the ticket by hand.
- No tracker pickup/skip lines at all — nothing has changed since the last cursor in `.devintern-code/queue.db`. A ticket last edited before that cursor is not re-evaluated until something on the tracker updates.

## Options

The daemon itself takes almost no flags. Durable settings live in `workspace.toml`:

```toml
[workspace]
dashboard = true          # false disables the embedded dashboard
dashboard_port = 4400     # optional; default 4400

[defaults]
task_query = "status=todo"
worker_task_args = "--create-pr"
poll_interval = 60
```

| Option              | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| `--workspace <path>` | Use this `workspace.toml` (default `~/.devintern/workspace.toml`) |
| `-v, --verbose`     | Verbose logging                                                     |

Unattended automation is exactly where sandboxing the agent matters most: set `AGENT_SANDBOX=auto` in the workspace `.env` to confine agent runs to the project workspace. See [Sandboxing the Agent](./configuration.md#sandboxing-the-agent) for providers and setup.

## Review feedback on the agent's PRs

In polling mode the worker also watches the pull requests it created (no webhook needed). When a human requests changes or leaves new inline review comments on one of the agent's own PRs, the worker addresses the feedback automatically; no mention is required on its own PRs. Closed and merged PRs leave the watch list on their own.

The watch list is scoped to repos listed in `workspace.toml`. Registry entries for any other repo — typically left behind when a repository is renamed or transferred — are unwatched automatically at startup instead of being polled (and failing auth) forever.

The regular polling requests use ETags, and GitHub does not count `304 Not Modified` responses against the API rate limit. The worker makes unconditional PR requests only once to hydrate state after startup and immediately before an eligible base-sync attempt. Comparison results are reused for each immutable base/head SHA pair.

### Merge conflicts on the agent's PRs

When a watched PR falls behind its base branch, the worker catches the branch up automatically whether the base merges cleanly or conflicts. Eligibility comes from GitHub's own `mergeable_state` (`dirty` = conflicts, `behind` = mergeable but not up to date) — not from ancestry checks against the API-reported base SHA, a field GitHub can leave stale for days. The worker merges the base branch into the PR branch and, only when needed, asks the agent to resolve conflicted files (checking for semantic breakage, not just markers) before the merge is committed; every conflicting PR in the watch list is synced, not just one per tick. The result is pushed normally, never force-pushed: if a human moved the branch in the meantime, the push is rejected instead of being overwritten. A comment on the PR reports successful clean merges and conflict resolutions, and stacked PRs benefit the most, since merging one PR routinely advances the next PR's base.

This applies only to the agent's own PRs (the same watch list as review polling). Each base/head SHA pair is a durable event in `.devintern-code/queue.db`; new commits on the PR branch open a fresh event, so an exhausted attempt is retried after the next push. Failures retry up to `WEBHOOK_MAX_RETRIES` (default 3), including across worker restarts. Before acting, the worker requires the PR head SHA to remain unchanged for `WORKER_BASE_SYNC_QUIET_SECONDS` (default 30) and then re-fetches both SHAs. Recent or concurrent pushes defer the run without consuming an attempt; if a run defers several times in a row, the event is given up until the head or base moves again. GitHub's PR API can report an outdated `base.sha` for a while, so the resolver always merges the actual fetched tip of the base branch rather than trusting that field. Each resolve run is bounded by `WORKER_RESOLVE_TIMEOUT_SECONDS` (default 1800; `0` disables) — a hung resolver subprocess is killed and counted as a failed attempt, and runs left `in_progress` by a crashed or killed worker are marked failed at the next startup. The same merge logic is available manually for any PR via `devintern resolve-conflicts <pr-url>`.

## Mention the bot on any PR

The worker also reacts to mentions on pull requests it did not create. When a teammate writes a comment like `@devintern address the review feedback` on any PR in the repository, the worker picks it up on the next poll and handles it through the same pipeline. Detection is a repository-wide sweep of new comments (two requests per interval, regardless of how many PRs are open), so mentions work without any webhook setup.

Guardrails apply before the agent acts:

- Only users with push access (write, maintain, or admin) can direct the agent. Mentions from read-only users and non-collaborators are ignored, and the check fails closed on errors.
- Fork PRs are skipped with an explanatory comment unless the PR allows maintainer edits.
- The worker never force-pushes; if a human pushed to the branch meanwhile, the push is rejected instead of overwriting.
- Mentions posted before the worker first started are not dug up.

Mention matching requires a resolvable bot identity, so this team/automation feature needs GitHub App auth (`GITHUB_APP_ID` plus a private key — the same requirement as webhook mention handling). A personal `GITHUB_TOKEN` is enough for review polling on the agent's own PRs, but not for `@mentions` on other people's PRs. See [Configuration](./configuration.md#github-authentication) and [Pricing](https://devintern.com/pricing/).

## How events are handled

- Events are persisted to a local SQLite queue (`.devintern-code/queue.db`) before processing, so a crash or restart never loses accepted work.
- Duplicate webhook deliveries are detected by GitHub's delivery id and skipped.
- Review feedback is processed before new task pickup: a human waiting on feedback beats a ticket that can wait a minute.
- One task or scheduled automation runs at a time per repository.

## Instant events with the relay

Polling reacts within one interval (about a minute). On its default path, `worker init` offers to sign in and pair the workspace with the [DevIntern relay](./relay.md), including GitHub and the active tracker. Events then reach the worker within seconds as reference envelopes (never code or comment content). Polling stays on as the fallback, so relay downtime only affects latency. The standalone `worker connect` commands remain available for adding or rotating individual registrations.

## Seeing what the worker did

Every run is recorded stage by stage in the local database. The worker serves the [observability dashboard](./dashboard.md) at `http://localhost:4400` by default; set `[workspace].dashboard = false` to disable it, or `[workspace].dashboard_port` to change the port. You can also run `devintern dashboard` standalone at any time (it works with the worker stopped too). If the dashboard port is unavailable, the worker logs a warning and continues processing.

## Running as a service

The worker runs identically on a laptop, VM, or container. `devintern worker init` can write a user-level systemd unit on Linux or a launchd agent on macOS into the workspace home, then prints explicit installation commands. It never installs or starts the service without you running those commands. Running `devintern worker` in a terminal remains fully supported. For pm2 and tunnel setups (advanced webhook mode), see the [GitHub Integration guide](./github-integration.md). If you need a wall-clock window instead of a resident process, see [Night-only CLI runs](./automated-task-processing.md#night-only-cli-runs).

## License

The worker is unattended automation and requires an automation license (Supporter, Team, or Business). Interactive runs stay free under the FSL license.
