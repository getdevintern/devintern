---
title: "Worker Daemon"
description: "Run devintern as a single long-running worker that reacts to PR reviews and tracker changes"
section: "Server Automation"
order: 0
dateModified: 2026-08-17
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

When a run cannot finish, devintern posts an "Implementation Incomplete" comment on the ticket and moves it back to your to-do status. The next pickup is gated so an unchanged ticket is not retried in a loop; you unlock a retry by changing the ticket:

- **Edit the description** with more detail, or
- **Post any comment** on the ticket (a one-line clarification is enough), or
- **Delete the bot's incomplete comment** from the ticket.

Either action bumps the ticket's update stamp, so the worker picks it up on the next change detection and the retry runs. On a retry the agent is told which attempt this is, why the previous attempt stopped, and which comments are new since then, so new guidance takes priority. Each attempt gets its own branch (`feature/{key}`, then `feature/{key}-attempt-2`, and so on).

If a run completes but you want a different result, move the ticket back to your to-do status (optionally with a comment describing what to change) and it re-runs the same way.

Retry bookkeeping lives in `.devintern-code/queue.db` next to the worker's cursors. For local one-off runs, `devintern TASK-123 --force` re-runs a task even if nothing on the ticket changed; do not put `--force` in `WORKER_TASK_ARGS`, since that would disable the gate for every polled task.

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

The polling is cheap: requests use ETags, and GitHub does not count `304 Not Modified` responses against the API rate limit. With `--listen`, review handling comes from webhooks instead and this poller stays off, so feedback is never handled twice.

### Merge conflicts on the agent's PRs

When a watched PR falls behind its base branch and GitHub reports merge conflicts, the worker catches the branch up automatically: it merges the base branch into the PR branch, and if the merge conflicts, the agent resolves the conflicted files (checking for semantic breakage, not just markers) before the merge is committed. The result is pushed normally, never force-pushed: if a human moved the branch in the meantime, the push is rejected and the merge is abandoned for them to handle. A comment on the PR reports what happened either way, and stacked PRs benefit the most, since merging one PR routinely conflicts the next one in the chain.

This applies only to the agent's own PRs (the same watch list as review polling). Each conflict state is attempted once: a failed resolution is retried only after the branch or its base moves again. The same logic is available manually for any PR via `devintern resolve-conflicts <pr-url>`.

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
- One task runs at a time per repository.

## Instant events with the relay

Polling reacts within one interval (about a minute). For instant reaction without hosting your own webhook endpoint, pair the worker with the [DevIntern relay](./relay.md): sign in, run `devintern worker connect` (and optionally `connect linear|asana|trello|azure-devops|jira` with that tracker's env vars), and events reach the worker within seconds as reference envelopes (never code or comment content). Polling stays on as the fallback, so the relay can never lose you events.

## Seeing what the worker did

Every run is recorded stage by stage in the local database. Add `--ui` to serve the [observability dashboard](./dashboard.md) alongside the daemon, or run `devintern dashboard` standalone at any time (it works with the worker stopped too).

## Spend caps (budget)

Unattended agents consume tokens, so the worker can cap its own spend:

| Environment variable          | Meaning                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `WORKER_MAX_SPEND_PER_RUN_USD`  | Soft cap for a single run's cost in US dollars                          |
| `WORKER_MAX_SPEND_PER_DAY_USD`  | Cap for total unattended spend per **UTC day** in US dollars            |

Both accept plain non-negative decimals (`10`, `4.50`). Negative values, non-numeric values, and currency suffixes are rejected at startup with an actionable error; unset or empty disables the cap.

How the caps behave:

- **Daily cap (`…_PER_DAY_USD`)** — checked immediately before admitting every new unattended run (polling, relay, webhook reviews, mentions, workspace fleets). When the known spend of unattended runs finished today meets the cap, the worker pauses new dispatch: queued/detected work is preserved and resumes after the next UTC midnight; a single one-line notice is logged when entering the capped state. Runs already in progress finish normally, their final usage is recorded, and only then is the budget re-evaluated — so a run admitted below the cap can push the total above it, but no further runs start.
- **Per-run cap (`…_PER_RUN_USD`)** — no supported harness exposes native spend cancellation, so this cannot abort an in-flight session. It behaves as a post-run cap: a run whose recorded cost exceeds the limit finishes and is recorded normally, then triggers a loud warning. The limitation is logged once at startup when this cap is set.

Only *known* costs count toward the caps. Runs whose usage could not be priced (unknown model, partial accounting) never silently count as $0 — they are surfaced as "unknown exposure" in capped-state notices and on the [dashboard](./dashboard.md). Costs prefer provider-reported figures and otherwise come from a built-in versioned pricing catalog; the source and pricing version are stored per run.

Manual `devintern TASK-123` executions are never affected by these caps.

## Running as a service

The worker runs identically on a laptop, VM, or container. `devintern worker init` can write a systemd service file to `.devintern-code/devintern-worker.service` with install instructions. For pm2 and tunnel setups (webhook mode), see the [GitHub Integration guide](./github-integration.md). In polling mode no public endpoint is needed, so a plain systemd service with `ExecStart=devintern worker --query "..."` is enough.

## License

The worker is unattended automation and requires an automation license (Supporter, Team, or Business), the same requirement scheduled runs have. Interactive runs stay free under the FSL license.
