---
title: "Worker Daemon"
description: "Run devintern as a single long-running worker that reacts to PR reviews and tracker changes"
section: "Server Automation"
order: 0
dateModified: 2026-08-26
---

# Worker Daemon

`devintern worker` runs devintern as a single long-running daemon on your own machine. It replaces the cron plus standalone webhook server setup: one process acquires events (reviews on the agent's PRs, ready tasks from your tracker) and executes them locally.

Your code, credentials, and agent execution never leave your machine.

## Quick Start

The fastest way to set up the worker is the guided setup (your tracker must already be configured; run `devintern init` first if not):

```bash
devintern worker init
```

It walks you through the ready-tasks query (and validates it against your tracker with a live dry run), polling vs. webhook mode (generating a `WEBHOOK_SECRET` when needed), checks your automation license up front, and can write a ready-to-install systemd service file.

Or configure by hand and start directly:

```bash
# Poll your tracker for ready tasks (no webhooks, no public endpoint)
devintern worker --query "status=todo"

# Also run the GitHub webhook listener (direct webhooks)
devintern worker --query "status=todo" --listen
```

`devintern serve` still works as a deprecated alias for `devintern worker --listen`.

## Recurring automations

For a single repository, put recurring work in `.devintern-code/automations.toml`:

```toml
[[automations]]
id = "dependency-health"
enabled = true
interval = "6h"
prompt = """Pick one outdated dependency and upgrade it within the same major version.
Run the test suite; if anything breaks, revert the upgrade instead of fixing forward."""

[[automations]]
id = "flaky-test-triage"
enabled = true
cron = "0 9 * * 1"
prompt = """Re-run the test suite twice and look for flaky tests.
For each flaky test, add a short comment explaining the suspected race condition.
Do not change production code."""
```

Every entry needs a stable unique `id`, boolean `enabled`, non-empty `prompt`, and exactly one schedule. Intervals use positive minutes, hours, or days (`15m`, `6h`, `1d`). Cron expressions have five fields and use the worker host's timezone in v1; persisted occurrence times are UTC.

Configuration is validated as a group at worker startup and changes require a restart. An automation file is itself a valid event source, so `devintern worker` stays running without `--query` or `--listen` when at least one automation entry is configured (disabled entries are validated but not scheduled).

### What an automation is

Automations are independent of your task tracker: **the prompt is the task**. Each occurrence writes the prompt to a local markdown task file and feeds it through exactly the same pipeline as any other task — clarity check, planning, implementation, commit, PR creation, auto-review, run records. Nothing is created in your tracker, so no tracker credentials are needed for automation-only workers.

Concretely, each occurrence:

1. Writes `.devintern-code/automations/<id>/<timestamp>.md` (resolved like every other devintern state: the nearest `.devintern-code` walking up from the working directory).
2. Spawns the normal CLI on that file as a subprocess, so the run gets its own branch, commits, and — by default — a pull request.
3. Records the attempt with the `scheduled` origin and the automation id, so you can filter scheduled runs in the [dashboard](./dashboard.md).

Because the occurrence is just a markdown task, you can reproduce or rerun any occurrence by hand:

```bash
devintern .devintern-code/automations/dependency-health/2026-08-24T09-00-00-000Z.md
```

### Writing good prompts

The prompt replaces the ticket description the agent would normally read, so treat it like you would write a task for a new teammate:

- **Scope it to one change per run.** "Apply one safe improvement" produces reviewable PRs; "clean up the repository" produces sprawling ones.
- **State the guardrails.** What not to touch, when to stop, what must pass (`Run the test suite before committing`).
- **Say what done means.** The pipeline's incomplete-detection reads the agent output; concrete success criteria make escalations rare.
- Prefer recurring maintenance work (dependency bumps within a major, flaky-test triage, changelog refreshes, TODO sweeps) over open-ended feature work.

### Tuning how occurrences run

Occurrences use the same flag defaults as polled tasks: `WORKER_TASK_ARGS` overrides them (default `--create-pr`). For example, set `WORKER_TASK_ARGS=--auto-review` to have every automated PR go through the review loop too, or clear it to keep runs local without PRs. Note this variable applies to polled tracker tasks as well.

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
| Task files pile up under `.devintern-code/automations/` | They are small and safe to delete — they are only run inputs; the durable record is the run history in `queue.db`. |

## Polling mode

With `--query` (or `WORKER_TASK_QUERY`), the worker polls your tracker on an interval (default 60 seconds) and runs every task that matches the query. The query uses the same language as batch `--query` runs for your tracker, so "ready" means whatever your query says, for example a status or label.

How a poll cycle works:

1. A cheap change detector asks the tracker "did anything change since the last cursor?" and nothing else.
2. Only when something changed, the worker re-runs your query to get the tasks that are actually ready.
3. Each ready task is picked up once per change: the worker remembers the task's last seen update stamp, so a task re-enters only when it is updated again.
4. Tasks run one at a time through the normal pipeline (branch, implementation, PR, tracker updates), with `WORKER_TASK_ARGS` controlling the flags (default `--create-pr`).

Cursors persist in `.devintern-code/queue.db`; after a restart the worker resumes where it left off instead of starting from "now".

Polling is available for all seven trackers: Jira, Linear, GitHub Issues, Azure DevOps, Asana, Trello, and markdown. Trello polling uses the board actions feed and requires `TRELLO_DEFAULT_BOARD_ID`; Asana polling uses the Events API and requires `ASANA_DEFAULT_PROJECT_GID`. A folder of markdown tasks is the fastest way to try the worker: no tracker account needed.

```bash
TASK_TRACKER=markdown MARKDOWN_TASKS_DIR=./tasks devintern worker --query "status=todo"
```

### Re-running a task

When a run cannot finish, devintern posts an "Implementation Incomplete" comment on the ticket (crash, interrupt, and failed-feasibility comments do the same) and moves it back to your to-do status. That comment tells you how to unlock a retry. The next pickup is gated so an unchanged ticket is not retried in a loop; you unlock a retry by changing the ticket:

- **Edit the description** with more detail, or
- **Post any comment** on the ticket (a one-line clarification is enough), or
- **Delete the bot's incomplete comment** from the ticket.

Either action bumps the ticket's update stamp, so the worker picks it up on the next change detection and the retry runs. On a retry the agent is told which attempt this is, why the previous attempt stopped, and which comments are new since then, so new guidance takes priority. Each attempt gets its own branch (`feature/{key}`, then `feature/{key}-attempt-2`, and so on).

If a run completes but you want a different result, move the ticket back to your to-do status (optionally with a comment describing what to change) and it re-runs the same way.

Retry bookkeeping lives in `.devintern-code/queue.db` next to the worker's cursors. For local one-off runs, `devintern TASK-123 --force` re-runs a task even if nothing on the ticket changed; do not put `--force` in `WORKER_TASK_ARGS`, since that would disable the gate for every polled task.

### Ticket matches the query but is not picked up

The worker log is the diagnostic. Look for `[poll:<tracker>]` (for Jira, `[poll:jira]`):

- `📌 picking up KEY` — it was claimed on this tick.
- `⏭️ skipping KEY (already processed at this update)` — this ticket was already claimed at this version. Edit or comment on it so its update stamp changes, then wait for the next change detection.
- `have no update stamp from the tracker` — search results are missing `updated`, so the worker cannot tell versions apart and will not retry after the first attempt. Restarting the worker does not help; a one-off `devintern KEY` still runs the ticket by hand.
- No tracker pickup/skip lines at all — nothing has changed since the last cursor in `.devintern-code/queue.db`. A ticket last edited before that cursor is not re-evaluated until something on the tracker updates.

## Options

| Option              | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| `--query <query>`   | Poll the tracker for ready tasks matching this query                |
| `--listen`          | Also run the GitHub webhook listener (direct webhooks)              |
| `--port <port>`     | Webhook listener port (default: 3000 or `WEBHOOK_PORT`)             |
| `--host <host>`     | Webhook listener host (default: 0.0.0.0 or `WEBHOOK_HOST`)          |
| `--interval <secs>` | Polling interval in seconds (default: 60 or `WORKER_POLL_INTERVAL`) |
| `--ui`              | Also serve the local [observability dashboard](./dashboard.md)      |
| `--ui-port <port>`  | Dashboard port (default: 4400 or `DASHBOARD_PORT`)                  |
| `--sandbox <name>`  | Run agents inside an OS-level sandbox (overrides `AGENT_SANDBOX`)   |
| `-v, --verbose`     | Verbose logging                                                     |

Unattended automation is exactly where sandboxing the agent matters most: set `AGENT_SANDBOX=auto` in `.devintern-code/.env` (or pass `--sandbox`) to confine agent runs to the project workspace. See [Sandboxing the Agent](./configuration.md#sandboxing-the-agent) for providers and setup.

## Review feedback on the agent's PRs

In polling mode the worker also watches the pull requests it created (no webhook needed). When a human requests changes or leaves new inline review comments on one of the agent's own PRs, the worker addresses the feedback automatically; no mention is required on its own PRs. Closed and merged PRs leave the watch list on their own.

The watch list is scoped to the project the worker runs in: single-repo mode watches only PRs on that checkout's GitHub repo, and workspace mode only repos listed in `workspace.toml`. Registry entries for any other repo — typically left behind when a repository is renamed or transferred, or by an older checkout sharing the same `.devintern-code/` state — are unwatched automatically at startup instead of being polled (and failing auth) forever.

The regular polling requests use ETags, and GitHub does not count `304 Not Modified` responses against the API rate limit. The worker makes unconditional PR requests only once to hydrate state after startup and immediately before an eligible base-sync attempt. Comparison results are reused for each immutable base/head SHA pair. With `--listen`, review handling comes from webhooks instead and this poller stays off, so feedback is never handled twice.

### Merge conflicts on the agent's PRs

When a watched PR falls behind its base branch, the worker catches the branch up automatically whether the base merges cleanly or conflicts. Eligibility comes from GitHub's own `mergeable_state` (`dirty` = conflicts, `behind` = mergeable but not up to date) — not from ancestry checks against the API-reported base SHA, a field GitHub can leave stale for days. The worker merges the base branch into the PR branch and, only when needed, asks the agent to resolve conflicted files (checking for semantic breakage, not just markers) before the merge is committed; every conflicting PR in the watch list is synced, not just one per tick. The result is pushed normally, never force-pushed: if a human moved the branch in the meantime, the push is rejected instead of being overwritten. A comment on the PR reports successful clean merges and conflict resolutions, and stacked PRs benefit the most, since merging one PR routinely advances the next PR's base.

This applies only to the agent's own PRs (the same watch list as review polling). Each base/head SHA pair is a durable event in `.devintern-code/queue.db`; new commits on the PR branch open a fresh event, so an exhausted attempt is retried after the next push. Failures retry up to `WEBHOOK_MAX_RETRIES` (default 3), including across worker restarts. Before acting, the worker requires the PR head SHA to remain unchanged for `WORKER_BASE_SYNC_QUIET_SECONDS` (default 30) and then re-fetches both SHAs. Recent or concurrent pushes defer the run without consuming an attempt; if a run defers several times in a row, the event is given up until the head or base moves again. GitHub's PR API can report an outdated `base.sha` for a while, so the resolver always merges the actual fetched tip of the base branch rather than trusting that field. Each resolve run is bounded by `WORKER_RESOLVE_TIMEOUT_SECONDS` (default 1800; `0` disables) — a hung resolver subprocess is killed and counted as a failed attempt, and runs left `in_progress` by a crashed or killed worker are marked failed at the next startup. The same merge logic is available manually for any PR via `devintern resolve-conflicts <pr-url>`.

### Syncing every open PR (`WORKER_BASE_SYNC_ALL_PRS`)

By default only the agent's own PRs are synced, as described above. Set `WORKER_BASE_SYNC_ALL_PRS=true` in `.devintern-code/.env` to extend automatic base sync to **every open pull request** in the repo(s) the worker manages — useful when human teammates' long-lived branches also fall behind their base.

Behavior with the flag enabled:

- Discovery polls each watched repo's open-PR list every tick using conditional (ETag-cached) requests, so idle ticks stay rate-limit-free. The first sweep after startup fetches PR details once per open PR; afterwards only changed PRs cost requests. The list covers up to the first 100 open PRs per repo — while a repo sits at that page-size cap, the worker logs a warning, since PRs beyond it are invisible to discovery.
- Closed and merged PRs drop out of the open list on their own; draft PRs are never auto-synced (a draft signals work in progress).
- Fork PRs are skipped: devintern cannot — and should not — push merges to forks, so conflicts there remain the author's to resolve.
- Review feedback handling stays an own-PR feature: other people's PRs are only ever caught up with their base, never addressed or replied to beyond the sync outcome.
- Everything else works exactly as for the agent's own PRs: quiet period, durable per-SHA events, retry limits, no force-pushes, and branch protection rules apply equally.

**Trust boundaries:** unlike the agent's own PRs, these branches are authored by anyone who can open a PR, so their content is untrusted input. What contains it: all resolution work happens inside a dedicated branch-scoped worktree under `/tmp/`, never in your checkout; fork PRs and drafts never enter the pipeline; merge pushes are lease-verified and never forced; and each resolver subprocess is killed at `WORKER_RESOLVE_TIMEOUT_SECONDS` (default 1800). What does *not* contain it: genuine conflict resolution hands the conflicted tree to the coding agent, which may run project tooling (typecheck/tests) inside that worktree — the same pipeline the agent's own PRs use. On repositories that accept PRs from arbitrary third parties, run the agent sandboxed (`AGENT_SANDBOX`, see [Sandboxing the Agent](./configuration.md#sandboxing-the-agent)) and let branch protection decide what actually lands. There is no per-author allowlist: the flag is all-or-nothing per watched repo.

The sweep also needs at least one repo target. Single-repo workers derive it from the checkout's detected GitHub repo (workspace mode uses `workspace.toml`); if detection fails and the agent has no open PR yet, discovery has nothing to run on and the worker logs a "nothing to sweep" warning until a target exists.

Sync activity on non-devintern PRs is fully auditable: the worker logs each foreign PR it starts/stops watching (`👀 … watching owner/repo#N (open PR) for base sync`) and marks its sync lines with `(external PR)`; the resolver posts a comment on the PR describing what was merged; and every attempt is recorded as a `conflict_resolution` run in the [dashboard](./dashboard.md).

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

Polling reacts within one interval (about a minute). For instant reaction without hosting your own webhook endpoint, pair the worker with the [DevIntern relay](./relay.md): sign in, run `devintern worker connect` (and optionally `connect linear|asana|trello|azure-devops|jira` with that tracker's env vars), and events reach the worker within seconds as reference envelopes (never code or comment content). Polling stays on as the fallback, so the relay can never lose you events.

## Seeing what the worker did

Every run is recorded stage by stage in the local database. Add `--ui` to serve the [observability dashboard](./dashboard.md) alongside the daemon, or run `devintern dashboard` standalone at any time (it works with the worker stopped too).

## Running as a service

The worker runs identically on a laptop, VM, or container. `devintern worker init` can write a systemd service file to `.devintern-code/devintern-worker.service` with install instructions. For pm2 and tunnel setups (webhook mode), see the [GitHub Integration guide](./github-integration.md). In polling mode no public endpoint is needed, so a plain systemd service with `ExecStart=devintern worker --query "..."` is enough.

## License

The worker is unattended automation and requires an automation license (Supporter, Team, or Business), the same requirement scheduled runs have. Interactive runs stay free under the FSL license.
