---
title: "Worker Daemon"
sidebarLabel: "Worker"
description: "Run devintern as a single long-running worker that reacts to PR reviews and tracker changes"
section: "Automation"
order: 2
dateModified: 2026-10-16
---

# Worker Daemon

`devintern worker` runs devintern as a single long-running workspace daemon on your own machine. It acquires events for every configured repository and executes them locally.

Your code, credentials, and agent execution never leave your machine.

## Quick Start

The fastest way to set up the worker is the guided setup:

```bash
devintern worker init
```

`worker init` reuses tracker config from `devintern init` (or runs that subset if missing), writes a 1-repo [workspace](./workspaces.md), validates and stores the ready-tasks query, configures task pickup hours plus conflict/CI repair policy, optionally validates and adds a Sentry auto-fix project, and checks automation access. Without a paid license, it offers sign-in for the no-card Worker Pilot. It then offers zero-port relay setup plus the central DevIntern App and can install and start a user-level systemd unit on Linux or launchd agent on macOS. Declining keeps it manual and writes the definition plus exact install commands into the workspace home; `--no-service` skips service setup entirely. Polling provides fallback acquisition when the relay is unavailable. The repo-local direct webhook server is an advanced, separate service and is not part of this wizard.

In the standard path, install the central [DevIntern AI App](https://github.com/apps/devintern-ai/installations/new) on the repositories in your workspace. Its private key stays on DevIntern infrastructure and events arrive as reference-only relay envelopes. Your local `GITHUB_TOKEN` fetches PR data, checks permissions, replies, and creates PRs. `worker init` registers every GitHub repository already listed in `workspace.toml`; after adding repositories, `devintern worker connect` verifies every workspace repo still awaiting pairing.

If the relay is intentionally unavailable, the wizard does not offer the hosted App. Polling and the worker's own PRs still work with `GITHUB_TOKEN`; air-gapped mention handling uses the advanced customer-owned App setup in [GitHub authentication](./configuration.md#advanced-customer-owned-github-app).

Or configure by hand and start directly:

```bash
# After a workspace exists (`worker init`, or `worker scaffold` + `worker add-repo`)
devintern worker

# Advanced: run the repo-local GitHub webhook listener separately
devintern webhook serve
```

## Agent failover

Set `AGENT_HARNESS=codex,grok` (comma-separated, priority first) in the workspace `.env` so the worker keeps going when one agent hits a usage limit. Failover applies to every worker job: tracker tasks, PR review addressing, `@mention` runs, conflict resolution, scheduled automations, estimations, dashboard retries, and relay-driven work — except automations or estimations that pin their own `harness` (see [Choosing the agent per schedule](#choosing-the-agent-per-schedule)). Details: [Failover across multiple harnesses](./configuration.md#failover-across-multiple-harnesses).

## Error-monitor auto-fixes

`[[error_monitors]]` entries let the worker turn unresolved production errors
into normal repo-scoped fix runs. Add the first project during `worker init`, or
run `devintern worker connect sentry` for an existing workspace. Each Sentry project maps explicitly to one
`[[repos]]` entry and can inherit an optional `[[teams]]` environment, so one
worker can safely serve multiple teams, repositories, and credentials. See
[Sentry Auto-fixes](./sentry-integration.md) for the schema and setup.

## Recurring automations

Put recurring work in `workspace.toml`. Set `repo` when the workspace has multiple repositories; it is optional for a one-repo workspace:

To configure this through a coding agent, use the [devintern-workspace skill](https://github.com/getdevintern/devintern/tree/main/skills/devintern-workspace). For example: "Add a weekly dependency-health automation for web-app, Mondays at 09:00 in the worker host's timezone, opening a PR for at most one verified upgrade." The skill covers prompt writing, schedule and PR settings, validation, and checking that the running worker accepted the change.

```toml
[[automations]]
id = "dependency-health"
enabled = true
repo = "web-app"
interval = "6h"
open_pr = true
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

[[automations]]
id = "weekday-tweets"
enabled = true
repo = "web-app"
cron = "0 21 * * 1-5"
# open_pr is off by default — occurrences must not touch the repository's PRs.
prompt = """Draft one tweet about the product and save it as a markdown file
under ~/Documents/Tweets/."""
```

Every entry needs a stable unique `id`, boolean `enabled`, non-empty `prompt`, and exactly one schedule. Intervals use positive minutes, hours, or days (`15m`, `6h`, `1d`). Cron expressions have five fields and use the worker host's timezone in v1; persisted occurrence times are UTC.

### Opening a pull request is opt-in

Each automation says explicitly whether its occurrences open a pull request via `open_pr` (boolean, default `false`). PR creation is pipeline policy, not a prompt instruction: the prompt says what to produce, and `open_pr` says whether the run should become a reviewable pull request.

- **Off (the default).** Omit `open_pr` or set `open_pr = false` and an occurrence opens no pull request, pushes no review branch, and applies no PR labels — even if `[defaults].worker_task_args` still contains `--create-pr` or `--auto-review`. Workspace-level flags never turn PR creation on for an automation whose setting is off, and auto-review never runs. This is the right default for work whose output lands outside the repository (tweet drafts, reports written to another folder).
- **Opt-in.** Set `open_pr = true` for code-changing jobs that should be reviewed — dependency bumps, test triage, safe refactors. Those runs still honor `[defaults].worker_task_args` (auto-review, `--auto-review-iterations`) and the repo's PR labels, and `--create-pr` is applied even when the configured value omits it — `open_pr = true` alone guarantees the run becomes a pull request.

The dashboard's Automations table shows an **opens PR** badge per row; the dash (default) means off. **Run now** uses the same setting as the schedule, so you can validate a non-PR automation without a PR appearing.

Migrating an existing workspace: PRs used to be the default. Any automation that should keep opening PRs (dependency-health-style jobs) must set `open_pr = true` — if you upgrade without touching the config, every automation silently stops creating PRs.

### Allowing a no-op run

Some recurring jobs are supposed to do nothing when there is nothing to do — "keep main green", "release only when warranted", "find flaky tests". Their prompts say to make no changes and report, but a PR-opening run with no commit used to fail with `Implementation was not committed`.

Set `allow_no_changes = true` (boolean, default `false`) on those entries. When the agent finishes without changing the repository, the occurrence is recorded as a successful no-op: the run succeeds, no branch or PR is created, and no review or publish step runs. Without the flag the existing behavior is unchanged — a missing commit still fails the run.

```toml
[[automations]]
id = "main-red-fixer"
enabled = true
interval = "12h"
repo = "devintern"
open_pr = true
allow_no_changes = true
prompt = """Keep main green. If the latest CI run on main succeeded,
make no changes and report that main is already green."""
```

The equivalent CLI flag is `--allow-no-changes` for a one-off run. Scheduled occurrences receive it automatically from the automation setting.

Configuration is validated on load; while the worker runs it revalidates edits to `workspace.toml` automatically (SIGHUP forces a reload) — see [Workspaces → Editing workspace.toml while running](./workspaces.md#editing-workspace.toml-while-running). A non-boolean `open_pr` is rejected like every other invalid `[[automations]]` field, and the last valid config keeps serving. Automations are a valid event source, so `devintern worker` stays running without a task query when at least one automation entry is configured (disabled entries are validated but not scheduled).

### What an automation is

Automations are independent of your task tracker: **the prompt is the task**. Each occurrence writes the prompt to a local markdown task file and feeds it through exactly the same pipeline as any other task — clarity check, planning, implementation, and run records. Whether the run also becomes a pull request is the automation's own `open_pr` setting: **off unless switched on** (see below). Nothing is created in your tracker, so no tracker credentials are needed for automation-only workers.

Concretely, each occurrence:

1. Writes `~/.devintern/automations/<id>/<timestamp>.md` (or the equivalent under `DEVINTERN_WORKSPACE_DIR`).
2. Spawns the normal CLI on that file as a subprocess — with the PR pipeline only when `open_pr = true` (otherwise no branch, no push, no PR).
3. Records the attempt with the `scheduled` origin and the automation id, so you can filter scheduled runs in the [dashboard](./dashboard.md).

Because the occurrence is just a markdown task, you can reproduce or rerun any occurrence by hand:

```bash
devintern ~/.devintern/automations/dependency-health/2026-08-24T09-00-00-000Z.md
```

You usually don't have to: the [dashboard](./dashboard.md#run-an-automation-now) has a **Run now** action per automation that executes the prompt immediately through this same pipeline and records the attempt with the `manual` origin, so new or edited configurations can be validated in seconds instead of waiting for the next schedule window.

### Writing good prompts

The prompt replaces the ticket description the agent would normally read, so treat it like you would write a task for a new teammate:

- **Scope it to one change per run.** "Apply one safe improvement" produces reviewable PRs; "clean up the repository" produces sprawling ones.
- **State the guardrails.** What not to touch, when to stop, what must pass (`Run the test suite before committing`).
- **Say what done means.** The pipeline's incomplete-detection reads the agent output; concrete success criteria make escalations rare.
- Prefer recurring maintenance work (dependency bumps within a major, flaky-test triage, changelog refreshes, TODO sweeps) over open-ended feature work.

### Tuning how occurrences run

When `open_pr = true`, occurrences receive the same flags as polled tasks: `[defaults].worker_task_args` in `workspace.toml` (default `--create-pr`). For example, set `worker_task_args = "--create-pr --auto-review"` to have every automated PR go through the review loop too, and add `--auto-review-iterations 3` to the same value (or set the `AUTO_REVIEW_ITERATIONS` env var) to raise the shared review–fix cycle cap (default: 2). This setting applies to polled tracker tasks as well. Automations with `open_pr` off (the default) are never affected by these flags — PR and review flags are stripped from them and `--no-git` is applied instead.

### Choosing the agent per schedule

By default every run uses the workspace `AGENT_HARNESS` / `AGENT_MODEL` / `AGENT_EFFORT` from the [environment layers](./configuration.md). An individual `[[automations]]` or `[[estimations]]` entry can override the agent for its own runs, so a cheap model can handle a daily triage job while a frontier model handles release work:

```toml
[[automations]]
id = "log-triage"
enabled = true
interval = "1d"
harness = "codex"
model = "gpt-5-codex"
effort = "low"
prompt = "Summarize new errors and file at most one issue."

[[automations]]
id = "release-manager"
enabled = true
cron = "0 9 * * 1"
harness = "claude-code"
effort = "high"
open_pr = true
prompt = "Cut the next release and update the changelog."
```

- `harness` names **one** registered agent (aliases such as `agy` resolve to their canonical name). An unknown name fails validation, naming the entry id and the `harness` field. Because a pin opts out of failover, the worker warns at startup (and on config reload) when an entry's `harness` is registered but its CLI is not installed or its `<HARNESS>_CLI_PATH` points at a missing executable, so the problem is visible before the first occurrence.
- `model` is a harness-specific string (see that agent's CLI docs) and is never validated cross-harness. Because it only makes sense for one agent, it is applied only when the entry also sets `harness`; without `harness` the inherited `AGENT_MODEL` (if any) is kept. When `harness` names a different agent than the workspace primary, an inherited `AGENT_MODEL` chosen for that primary is dropped unless the entry sets `model`.
- `effort` accepts only `low`, `medium`, or `high`; anything else fails validation. Like `model`, it is applied only when the entry also sets `harness`, and an inherited `AGENT_EFFORT` is dropped when the pin changes the harness unless the entry sets `effort`. It is applied only for harnesses that support reasoning effort — on any other harness it is ignored with a warning, and the run proceeds.
- Precedence for the entry's runs is **entry field > team/repo env > workspace env > harness default**. Fields you omit fall through to the existing workspace/repo/team values, and entries that set none of the three fields behave exactly as before.
- An entry that pins `harness` uses exactly that agent and opts out of the workspace `AGENT_HARNESS` failover chain for its runs; entries without `harness` keep normal failover and never receive a harness-specific `model`/`effort` the entry did not pair with a `harness`. A pinned harness also drops the inherited global `AGENT_CLI_PATH` (which names the workspace primary's binary) and, for a non-`claude-code` pin, the resolver's `CLAUDE_CLI_PATH` fallback, so it resolves its own `<HARNESS>_CLI_PATH` or default. The selection applies to subsequent occurrences after a live reload; a run already in flight keeps the agent it started with.

### Schedule semantics

Schedule cursors and claims live in `queue.db`. Missed occurrences coalesce to at most one immediate run after startup. The occurrence cursor advances atomically when claimed, so a crash does not replay a possibly completed run. Active claims receive heartbeats; after two minutes without a heartbeat a later due occurrence may recover the stale claim. If the same automation is still active at its next occurrence, that occurrence is logged and skipped without creating a run record. If the repository lock is held by another task, the occurrence is also skipped. This is an at-most-once policy: skipped occurrences are not replayed. A dashboard-triggered manual run holds the same lease while it is active, so a scheduled occurrence coming due mid-validation is skipped rather than run concurrently.

On shutdown the scheduler stops its timer, terminates active automation subprocess groups, waits for them to exit, and leaves their claims recoverable in SQLite.

### Troubleshooting

| Symptom                                              | Likely cause                                                                                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No occurrences fire after editing the TOML           | Check the worker log: the reload logs validation errors naming the offending entry, and changing a schedule resets its cursor (the next run is the next scheduled time, not immediately). |
| `occurrence skipped: previous run is active`         | The previous occurrence still runs (or its lease is stale). Long prompts may simply need a longer schedule.                                                                               |
| `occurrence skipped: repository is busy`             | Another task holds the repo run lock; the next occurrence will retry.                                                                                                                     |
| Scheduled runs missing from the dashboard            | Filter the run list by origin `scheduled`; check the worker has an automation license (startup log).                                                                                      |
| Task files pile up under `~/.devintern/automations/` | They are small and safe to delete — they are only run inputs; the durable record is the run history in `queue.db`.                                                                        |
| A run failed and you need to know why                | Open the dashboard's Logs tab to read recent worker output without a shell on the machine ([details](./dashboard.md)).                                                                    |
| The dashboard Logs tab is empty                      | The daemon tees its output to `worker.stdout.log` / `worker.stderr.log` in the workspace home. Check those files or `journalctl --user -u devintern-worker`.                              |

## Scheduled story-point estimation

`[[estimations]]` in `workspace.toml` runs unattended `--estimate` sweeps on a schedule. Entries use the same schedule grammar as `[[automations]]`, but the body is a **query**, not a prompt — there is no implementation, no branch, no worktree, no PR, and no `repo` key even in multi-repo workspaces:

```toml
[[estimations]]
id = "weekday-groom"
enabled = true
cron = "0 9 * * 1-5"
query = "status = 'To Do' AND labels IN (NeedsEstimate)"

[[estimations]]
id = "sprint-gaps"
enabled = true
cron = "0 10 * * 3"
query = "sprint in openSprints() AND \"Story Points\" is EMPTY"
```

Each entry needs a unique `id`, boolean `enabled`, non-empty `query`, and exactly one of `cron` or `interval`. Omitting the table (or leaving every entry disabled) changes nothing: estimation is simply off, and `[defaults].task_query` is never estimated as a side effect. The workspace tracker must support estimation (Jira, Linear, Azure DevOps, Asana via a custom field; GitHub and GitLab post comment-only estimates); Trello/markdown workspaces fail at startup with a clear error. `worker init` does not ask about estimations — add tables by hand.

Estimation entries accept the same optional `harness`, `model`, and `effort` overrides as `[[automations]]`, so a scheduled sweep can run on a cheap model — see [Choosing the agent per schedule](#choosing-the-agent-per-schedule). Because estimation never touches a repository, these fields do not require (and are unaffected by) a `repo`.

Estimation entries live-reload with `workspace.toml`: added and re-enabled entries schedule their next future occurrence, changed schedules reset their cursor, query edits apply to the next sweep, and removed entries stop scheduling without interrupting a sweep already in progress.

When an entry comes due the worker runs one-shot `devintern --estimate --query "<query>"` from the workspace home. That path keeps all of the interactive behavior: tickets younger than 24 hours are skipped, already-estimated tickets are skipped unless the ticket changed since the estimate, changed tickets are re-estimated with the estimate comment updated in place, points are written to the tracker field, and usage-limit aborts exit cleanly so the next occurrence retries. Each sweep is recorded with its own `estimate` origin (plus the schedule id) in the [dashboard](./dashboard.md) — it never shows up as a scheduled implement run.

### Serialization

Agent usage limits are account-global. While scheduled estimation is configured, every agent run in the worker process — implement tasks, automation occurrences, PR reviews, conflict resolutions, and estimation sweeps — takes turns through one process-level gate, so at most one agent subprocess burns quota at a time.

Estimation shares the [automation scheduler](#schedule-semantics): durable cursors, leases, missed-occurrence coalescing, and overlap skipping live under `estimation:<id>` keys in `queue.db`.

```bash
# The CLI one-shot stays available for ad-hoc estimates:
devintern --estimate --query "project = PROJ AND status = 'To Do'"
```

## Polling mode

With `[defaults].task_query` in `workspace.toml`, the worker polls your tracker on an interval (`[defaults].poll_interval`, default 60 seconds) and runs every task that matches the query. The query uses the same language as batch `--query` runs for your tracker, so "ready" means whatever your query says, for example a status or label.

How a poll cycle works:

1. A cheap change detector asks the tracker "did anything change since the last cursor?" and nothing else.
2. Only when something changed, the worker re-runs your query to get the tasks that are actually ready.
3. Each ready task is picked up once per change: the worker remembers the task's last seen update stamp, so a task re-enters only when it is updated again.
4. Each ready task is handed to the workspace's admission supervisor and runs through the normal pipeline (branch, implementation, PR, tracker updates), with `[defaults].worker_task_args` controlling the flags (default `--create-pr`). Polling keeps running while tasks are in flight, so a task created during a run is picked up on the next tick and fills a free concurrency slot instead of waiting for the current batch to finish.

Cursors persist in `~/.devintern/state/queue.db`; after a restart the worker resumes where it left off instead of starting from "now".

Polling is available for all eight trackers: Jira, Linear, GitHub Issues, GitLab Issues, Azure DevOps, Asana, Trello, and markdown. Trello polling uses the board actions feed and requires `TRELLO_DEFAULT_BOARD_ID`; Asana polling uses the Events API and requires `ASANA_DEFAULT_PROJECT_GID`; GitLab Issues polling requires `GITLAB_TOKEN` and `GITLAB_PROJECT`. A folder of markdown tasks is the fastest way to try the worker: no tracker account needed. Point `[defaults].tracker` at `markdown`, set `MARKDOWN_TASKS_DIR` in the workspace `.env`, and put the ready-tasks filter in `[defaults].task_query`.

### Delivery failures

A run that leaves no implementation to publish — no uncommitted changes and no commits ahead of the PR target — fails, as does a run that fails pre-push validation or cannot push its branch. If the agent committed its own changes on the feature branch, the worker verifies and publishes those commits instead of requiring an additional working-tree commit. A failed run does not proceed to PR/MR creation or mark the task as completed. Agent process failures also stop delivery, even if the agent left local edits. Batch CLI exit status alone is not a per-task success signal; inspect the recorded run outcome in the [dashboard](./dashboard.md).

### Re-running a task

When a run cannot finish, devintern posts an "Implementation Incomplete" comment on the ticket (crash, interrupt, and failed-feasibility comments do the same) and moves it back to your to-do status. That comment tells you how to unlock a retry. The next pickup is gated so an unchanged ticket is not retried in a loop; you unlock a retry by changing the ticket:

- **Edit the description** with more detail, or
- **Post any comment** on the ticket (a one-line clarification is enough), or
- **Delete the bot's failure comment** from the ticket.

The gate ignores the automation's own comments: posting the failure comment (and moving the ticket back) updates the tracker's timestamp, but neither of those counts as a change, so a failed ticket sits still until a human edits it. This applies to every failure kind — incomplete implementations as well as crash, interrupt, and usage-limit comments.

Any of those actions bumps the ticket's update stamp, so the worker picks it up on the next change detection and the retry runs. On a retry the agent is told which attempt this is, why the previous attempt stopped, and which comments are new since then, so new guidance takes priority. When the previous attempt left complete recorded state — a branch plus its own implementation report — the retry **picks up where it stopped** (session pickup): the recorded branch is checked out and the prior report is handed to the agent so it inherits already-landed work instead of redoing it. When that state is incomplete (no branch, no report, or the branch is gone), the retry starts fresh and gets its own attempt branch (`feature/{key}`, then `feature/{key}-attempt-2`, and so on).

If a run completes but you want a different result, move the ticket back to your to-do status (optionally with a comment describing what to change) and it re-runs the same way.

Pickup only inherits runs from the same tracker, team, repository, and run origin. A branch held by a user-owned checkout is left untouched; only disposable worktrees inside the worker's repository worktree directory can be removed for pickup, and Git's removal refusals are respected. If checkout cannot be resumed, the new attempt's prompt describes a fresh run. If the inherited implementation is already committed and needs no new edits, delivery still runs configured verification and hooks before publishing those commits.

Retry bookkeeping lives in `~/.devintern/state/queue.db` next to the worker's cursors. For local one-off runs, `devintern TASK-123 --force` re-runs a task even if nothing on the ticket changed; do not put `--force` in `[defaults].worker_task_args`, since that would disable the gate for every polled task.

### Tickets already actioned after a PR

Once a ticket's pull request is created the worker records it as **actioned** in `~/.devintern/state/queue.db` and keeps it out of the sweep until the ticket genuinely changes — even when it still matches `[defaults].task_query`. This is what stops a label-based tracker (GitHub, GitLab) from re-implementing the same open issue in a loop, and it works for every polled tracker.

If the project configures `prStatus` in `.devintern-code/settings.json`, the worker also moves the ticket to that status/label first. The local marker is recorded even when no `prStatus` is set (the worker logs a warning suggesting one), and even when the transition fails — a missing label, missing permission, or transient API error never makes the worker lose track of the ticket or fail the run that just created the PR.

A ticket re-arms when any field the marker records changes:

- **Edit** the summary or description,
- **Re-open** a closed ticket (status/state change), or
- **Add or remove a label**.

The marker is captured _after_ the worker's own comment and status transition, so those never re-trigger a run. A ticket that still matches the query but is skipped is logged as `⏭️ skipping KEY (already actioned; no change since the PR)`.

### Interrupted runs are recovered on startup

A graceful stop (Ctrl-C, `SIGTERM`) comments on an in-flight ticket and moves it back to To Do. A hard crash — power cut, kernel panic, `kill -9`, a laptop that died — skips that cleanup, which used to leave the ticket stranded in "In Progress".

The worker now bridges that gap on startup. Before any new tickets are acquired, it detects task runs left `in_progress` by the previous (dead) worker instance and gives each affected ticket the same treatment a graceful shutdown would have: the processing-failure comment is posted (explaining that the worker exited unexpectedly before a pull request could be created, and how to unlock a retry), and the ticket is moved back to your To Do status so it is no longer stranded. Each recovery is logged.

**Avoiding duplicate stop comments.** When an interrupted child handles its shutdown feedback, it marks its own run in the workspace database. Startup recovery skips a second crash comment for that run, but still attempts to move a ticket left In Progress back to To Do if the shutdown transition failed. Session pickup continues to use the recorded branch and implementation report.

Recovery respects the retry gate: the requeued ticket is not re-run on restart (no duplicate execution). It sits in To Do like any other ticket whose last attempt failed, and runs again when the ticket changes — an edited description, a new comment, or `--force`.

**Session pickup.** When an interrupted run left complete recorded state — a branch and its own implementation report — the worker does not post a failure and restart from scratch. It queues a pickup retry (`--force`) that reuses the same branch and hands the prior report to the agent, so the work already done is inherited rather than redone. Incomplete state (no branch, no report, or a branch that no longer exists) falls back to the normal failure-and-requeue path above; the recorded run is authoritative, and a ticket a human has already moved out of In Progress is never resumed.

Two guards keep the recovery from making noise or causing harm:

- **Tickets that moved on are left alone.** If a ticket is no longer in your configured In Progress status (someone closed it, moved it to review, or otherwise handled it after the crash), the worker does not comment on or move it.
- **Very old orphans are not announced.** Runs started more than 7 days ago are marked failed in the database but produce no comment or transition, on the assumption they were already handled manually. Set `WORKER_ORPHAN_MAX_AGE_HOURS` in the workspace `.env` to change the cutoff (`0` disables the feedback for every orphan).

Runs from scheduled automations and PR reviews are not part of this: automations recover through their own claim machinery (the next occurrence picks up after a stale lease), and PR runs have their own comment flows.

### Ticket matches the query but is not picked up

The worker log is the diagnostic. Look for `[poll:<tracker>]` (for Jira, `[poll:jira]`):

- `📌 picking up KEY` — it was claimed on this tick.
- `⏳ KEY deferred; will retry next poll` — the target repository was busy, so the task was not attempted and its claim remains pending automatically.
- `⏭️ KEY skipped (previous attempt reported incomplete; ticket unchanged)` — the retry gate declined the unchanged ticket, so no run started and no PR was attempted. Edit the description or comment to unlock a retry (see [Re-running a task](#re-running-a-task)); the ticket stays deduped until it changes.
- `⏭️ skipping KEY (already processed at this update)` — this ticket was already claimed at this version. Edit or comment on it so its update stamp changes, then wait for the next change detection.
- `⏭️ skipping KEY (already actioned; no change since the PR)` — a PR was already created for this ticket. Edit its summary/description, re-open it, or change its labels to re-arm it; see [Tickets already actioned after a PR](#tickets-already-actioned-after-a-pr).
- `have no update stamp from the tracker` — search results are missing `updated`, so the worker cannot tell versions apart and will not retry after the first attempt. Restarting the worker does not help; a one-off `devintern KEY` still runs the ticket by hand.
- No tracker pickup/skip lines at all — nothing has changed since the last cursor in `~/.devintern/state/queue.db`. A ticket last edited before that cursor is not re-evaluated until something on the tracker updates.

One exception: an edit that arrives while that ticket's run is still in flight advances the cursor but is remembered durably in `~/.devintern/state/queue.db` and re-admitted once the run settles — including after a worker crash or restart — so the edit is not lost. A task deferred because its repository was busy is tracked the same way and retried on the next poll.

## Ad-hoc tasks (`worker add`)

To dispatch work from a coding agent, install the [devintern-delegate skill](agent-skills.md). It guides repository selection, self-contained task briefs, idempotent submission, and bounded waiting for results.

Not every task comes from a tracker. `devintern worker add` enqueues a one-off
task against a specific workspace repo, so dependency bumps, post-deploy fixes,
generated docs, and CI/cron/agent follow-ups run through the full pipeline
(checkout, agent, PR, retries) without polluting a tracker or driving the CLI by
hand:

```bash
devintern worker add --repo backend --title "Bump the lockfile"
devintern worker add --repo backend --title "Fix flaky checkout test" \
  --body-file - < context.md
devintern worker add --repo web --title "Regenerate API docs" \
  --idempotency-key nightly-docs --json
devintern worker add --resume local-fix-flaky-checkout-test
```

The task is materialized as a local markdown prompt in `~/.devintern/injected/`
and a durable row in the central DB, then picked up by the running worker on its
next poll — no `[[routing.rules]]` entry is needed because the row names its repo
explicitly. Tasks are attributed to the `local:add` source in worker logs, run
records, and the dashboard, and start on a `feature/local-<slug>` branch (the
`local-` prefix cannot collide with a tracker key).

| Option                     | Description                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--repo <name>`            | `[[repos]]` name to target (default: the only repo, else required)                                                              |
| `--title <text>`           | Task title (required unless `--resume`)                                                                                         |
| `--body <text>`            | Task description                                                                                                                |
| `--body-file <path>`       | Read the description from a file (`-` reads stdin)                                                                              |
| `--idempotency-key <key>`  | Dedupe key; while a task with the key is pending/running a retry reuses it, and once it settles the key starts a new occurrence |
| `--resume <taskKey>`       | Re-queue a settled ad-hoc task under its existing key (resumes its branch and prior report)                                     |
| `--wait`                   | Block until the run finishes; exit `0` on success, `1` on failure                                                               |
| `--wait-timeout <seconds>` | Give up waiting after this long (default 21600 = 6h; `0` waits without a limit)                                                 |
| `--json`                   | Emit a single `{ id, taskKey, repo, status, deduplicated }` object on stdout (failed `--wait` runs add an `error` field)        |
| `--workspace <path>`       | Use this `workspace.toml` (default `~/.devintern/workspace.toml`, or `DEVINTERN_WORKSPACE_DIR`)                                  |

Behavior to expect:

- **Durable.** Enqueue writes to `queue.db`, so a task survives worker restarts
  and runs on the next poll. If no worker is running the task is still queued —
  `worker add` says so — and `--wait` refuses to block. Settled rows are pruned
  after 30 days by default; set `WORKER_INJECTED_TASK_RETENTION_DAYS` to change
  that window.
- **Interrupted tasks are not auto-restarted.** A task that was mid-run when the
  worker died is marked `failed` at the next startup, and its run records why.
  Re-queue it explicitly with `--resume <taskKey>` (or the dashboard's
  **Re-queue task**): the row keeps its key, so the retry targets the same
  `feature/local-<slug>` branch and session pickup hands the prior attempt's
  report to the agent — when it recorded one — instead of starting a second
  branch and PR. A task that never started is still `pending` and needs no
  resume.
- **Concurrency.** Pending ad-hoc tasks are claimed together and run in
  parallel up to the workspace's `max_concurrency` / `max_concurrency_per_repo`
  limits, sharing capacity with polled, review, and automation work. A task
  deferred because its repo is busy is requeued for the next poll without
  blocking independent repos behind it.
- **Non-interactive.** The command returns after enqueue. `--wait` is the
  scripting hook: it polls the row and exits with the run's status. It fails fast
  if the worker disappears, and exits non-zero with a clear message once
  `--wait-timeout` (default 6 hours) elapses without the task settling — a live
  worker that keeps deferring the task (a usage-limit pause, a permanently
  saturated repo) can no longer make `--wait` hang forever. Pass
  `--wait-timeout 0` to wait without a limit.
- **Machine-readable.** With `--json`, stdout carries exactly one JSON object;
  every human/status line (license notices, "Enqueued…", the `--wait` progress
  line) goes to stderr, so `devintern worker add … --json | jq .` parses cleanly.
  `--wait --json` still emits a single object — the settled state, or a
  `status: "failed"` object with an `error` on a timeout/worker-stop/inconclusive
  wait — not an interim pending object plus a final one. Without `--json`,
  diagnostics and the result line print to stdout as usual.
- **Idempotency.** A task carrying `--idempotency-key` is reused (reported as
  `deduplicated`) only while an earlier task with that key is still pending or
  running, so a retried automation cannot create a duplicate. Once that task
  settles, enqueuing the same key starts a new task — a fixed key like
  `--idempotency-key nightly-docs` therefore drives a recurring job without
  changing the key each run.
- **Licensing.** Enqueuing automation work runs the same entitlement check as
  the daemon (paid automation license, or the no-card Worker Pilot).
- **Quiet hours.** Injected tasks are operator-initiated, so they bypass working
  windows like `devintern worker run-now`; no extra `run-now` is required.
- **PR behavior.** Injected runs inherit `[defaults].worker_task_args` (default
  `--create-pr`), so they open a pull request just like tracker tasks.

`--repo` is optional only in a one-repo workspace. With several repos, omitting
it fails and lists the valid names; an unknown `--repo` fails the same way. An
empty title, a body over 20,000 characters, and a missing `--body-file` are
rejected before anything is written. `--resume` takes no title, body, repo, or
idempotency key: the existing row already holds them, and an unknown task key
fails without writing anything.

## Working windows (quiet hours)

The drain of ready tasks can be limited to wall-clock windows — nights only is the classic case — using `[worker.schedule]` in `workspace.toml`:

```toml
[worker.schedule]
active = ["22:00-06:00"]   # pickup allowed only inside these daily windows
blocked = []               # subtract from active windows; wins on conflict
timezone = ""              # optional IANA name; blank = machine local time
catch_up_missed = true     # one catch-up drain if a whole window elapsed unused
```

Windows are wall-clock per day, may cross midnight (`start` greater than `end`), union when multiple are set, and resolve overlaps toward staying quiet (`blocked` always wins). Only **new-task pickup** pauses: review replies, @mentions, recurring automations, and relay events run normally, and any task already picked up finishes even after its window closes.

Timezone and DST details, missed-window catch-up, and status surfaces (startup banner, one-log-line-per-flip, dashboard strip) are described in [Working windows](./automated-task-processing.md#working-windows-quiet-hours). To force an immediate drain without touching the schedule, run `devintern worker run-now`.

## Options

The daemon itself takes almost no flags. Durable settings live in `workspace.toml`:

```toml
[workspace]
dashboard = true          # false disables the embedded dashboard
dashboard_port = 4400     # optional; default 4400
ci_failure_fix = false    # opt in to automatic CI repair on agent PRs

[defaults]
task_query = "status=todo"
worker_task_args = "--create-pr"
poll_interval = 60
```

| Option               | Description                                                       |
| -------------------- | ----------------------------------------------------------------- |
| `--workspace <path>` | Use this `workspace.toml` (default `~/.devintern/workspace.toml`, or `DEVINTERN_WORKSPACE_DIR`) |
| `-v, --verbose`      | Verbose logging                                                   |

Unattended automation is exactly where sandboxing the agent matters most: set `AGENT_SANDBOX=auto` in the workspace `.env` to confine agent runs to the project workspace. See [Sandboxing the Agent](./configuration.md#sandboxing-the-agent) for providers and setup.

## Keeping the worker up to date

A worker that runs for weeks should not wait for a manual `npm install -g` to get fixes. When `devintern` is **globally installed** (npm or bun `-g`), the worker checks the npm registry for a newer `@getdevintern/code` at most once per calendar day and, when it finds one and is idle, installs it and restarts itself on the new version — no operator action, no interrupted work.

The update is applied only while the worker is idle:

- A check that comes due while agent work is in flight simply waits; the job runs to completion and the update happens on a later idle pass. A job that runs longer than a day just defers the update.
- Once idle, new work is held for the duration of the check and install (queued work is deferred and picked up on the next poll; running jobs are never aborted). A skip releases the hold immediately.
- After a successful install the worker shuts down cleanly and comes back on the new version. Under a service manager (systemd user unit, launchd agent) the exit asks for a restart and the manager relaunches it; running in a plain terminal, the worker hands over to a freshly spawned process on the new binary by itself. The generated definitions opt into this automatically (systemd exports its own markers, and the generated launchd agent sets `DEVINTERN_SERVICE=1`); a **hand-written** launchd agent must set `DEVINTERN_SERVICE=1` in its `EnvironmentVariables` so the worker uses the restart path instead of spawning its own successor alongside launchd's `KeepAlive`. Self-spawned successors carry a `DEVINTERN_HANDOVER=1` environment marker so a later update cycle knows the pid-1 parent it was reparented to on macOS is not a manager and hands over again instead of exiting for a restart that would never come.
- Failures never take the daemon down: registry, network, or install errors are logged, the current version keeps serving, and the next idle window retries after the daily interval.

Source checkouts, `bun link`, and local `node_modules` installs are never updated (the same policy as interactive CLI updates), and `DEVINTERN_NO_UPDATE=1` or `--no-update` skip the check entirely. To disable self-update for a workspace durably:

```toml
[worker]
auto_update = false
```

The opt-out is a live setting: removing it or flipping it back on applies without a restart. The worker log records each step — `[update] checking npm …`, skip reasons (opt-out, not a global install, busy, already current), `⬆ Auto-updating devintern X → Y`, and the restart — into the same capture files the dashboard tails. Interactive CLI prompts are unaffected; only the worker's own idle path installs updates.

## Review feedback on the agent's PRs

In polling mode the worker also watches the pull requests it created (no webhook needed). When a human requests changes or leaves new inline review comments on one of the agent's own PRs, the worker addresses the feedback automatically; no mention is required on its own PRs. Closed and merged PRs leave the watch list on their own: the watch list is reconciled with GitHub on every poll cycle, so PRs merged or closed outside the worker drop out of the open count within one poll. A GitHub 404 leaves the PR watched and warns about repository access, because GitHub can return 404 for an inaccessible PR that is still open.

If a run fails after the agent opened a PR itself (for example by running `gh pr create`), the worker adopts that open PR for the worktree's branch: it applies `pr_labels` and registers the PR in the watch list. The run still reports failed. This failure-path adoption currently looks up GitHub PRs only.

The watch list is scoped to repos listed in `workspace.toml`. Registry entries for any other repo — typically left behind when a repository is renamed or transferred — are unwatched automatically at startup instead of being polled (and failing auth) forever.

The regular polling requests use ETags, and GitHub does not count `304 Not Modified` responses against the API rate limit. The worker makes unconditional PR requests only once to hydrate state after startup and immediately before an eligible base-sync attempt. Comparison results are reused for each immutable base/head SHA pair.

### Merge conflicts on the agent's PRs

When a watched PR falls behind its base branch, the worker catches the branch up automatically whether the base merges cleanly or conflicts. Eligibility comes from GitHub's own `mergeable_state` (`dirty` = conflicts, `behind` = mergeable but not up to date) — not from ancestry checks against the API-reported base SHA, a field GitHub can leave stale for days. The worker merges the base branch into the PR branch and, only when needed, asks the agent to resolve conflicted files (checking for semantic breakage, not just markers) before the merge is committed; every conflicting PR in the watch list is synced, not just one per tick. The result is pushed normally, never force-pushed: if a human moved the branch in the meantime, the push is rejected instead of being overwritten. A comment on the PR reports successful clean merges and conflict resolutions, and stacked PRs benefit the most, since merging one PR routinely advances the next PR's base.

Success is verified, not assumed: after a push the resolver re-fetches the PR (a bounded window of a few seconds) and only reports success once GitHub shows the merge commit and no longer reports conflicts. If GitHub still says `dirty` after that window — usually because the base advanced again mid-run — the run counts as failed so another sync opens, and if the push itself cannot be published, every failure path posts a comment on the PR explaining what is missing, so automation never dies silently while the local work looked done.

Transient push problems recover on their own: a rejection caused by concurrent forward movement (someone pushed to the branch while the agent was resolving) triggers a bounded refresh-and-retry that rebuilds the merge on top of the new commits, keeping the eventual push a fast-forward. Rollbacks or history rewrites are left alone and deferred instead.

This applies only to the agent's own PRs (the same watch list as review polling). Each base/head SHA pair is a durable event in `~/.devintern/state/queue.db`; new commits on the PR branch open a fresh event, so an exhausted attempt is retried after the next push. Failures retry up to `WEBHOOK_MAX_RETRIES` (default 3), including across worker restarts, waiting out an exponential backoff between attempts (30s after the first failure, doubling up to 10 minutes) so persistent failures do not hammer the API on every poll tick. Before acting, the worker requires the PR head SHA to remain unchanged for `WORKER_BASE_SYNC_QUIET_SECONDS` (default 30) and then re-fetches both SHAs. Recent or concurrent pushes defer the run without consuming an attempt; if a run defers several times in a row, the event is given up until the head or base moves again. GitHub's PR API can report an outdated `base.sha` for a while, so the resolver always merges the actual fetched tip of the base branch rather than trusting that field. Each resolve run is bounded by `WORKER_RESOLVE_TIMEOUT_SECONDS` (default 1800; `0` disables) — a hung resolver subprocess is killed and counted as a failed attempt, and runs left `in_progress` by a crashed or killed worker are marked failed at the next startup. The same merge logic is available manually for any PR via `devintern resolve-conflicts <pr-url>`; manual runs exit non-zero with a clear message when the fix could not be published.

#### Scheduled conflict resolution

By default resolution runs as soon as a conflict is detected. Because each resolution is an agent run (and therefore token spend), workspaces on metered AI plans can batch it off-peak instead with `[workspace].conflict_resolution` in `workspace.toml`:

```toml
[workspace]
conflict_resolution = "scheduled"
conflict_resolution_cron = "0 3 * * *"   # or conflict_resolution_interval = "1d"
```

In scheduled mode the poller still detects every conflict on the first tick it appears and queues it durably (a pending base-sync event), but the agent is not invoked. When the scheduled window arrives — cron uses the worker host timezone, intervals are relative — the worker resolves all queued conflicts in one pass and logs the active mode and next window at startup. The window stays open for a grace period (`WORKER_RESOLVE_WINDOW_GRACE_MINUTES`, default 60) so quiet-period waits and retry backoffs inside the pass can still complete; anything unresolved when it closes waits for the next window. A window that arrives while the worker is down (missed nightly run) catches up on the first tick after restart. Stale resolutions cannot happen: before invoking the agent the worker re-fetches the PR, and closed/merged PRs or a conflict that resolved itself are dropped from the queue without spending tokens. The manual `devintern resolve-conflicts <pr-url>` command always works on demand, and once GitHub reports a PR conflict-free its queued event never triggers an agent run.

The setting applies to the whole workspace and live-reloads with `workspace.toml`. Between windows a conflicted PR cannot be merged, so teams that rely on instant rebases should keep `auto`. See [Workspaces → Automatic conflict resolution](./workspaces.md#automatic-conflict-resolution-auto-vs-scheduled-vs-disabled) for the config reference and tradeoffs.

To turn automatic conflict resolution off entirely — no detection, no queuing, no agent runs — set `conflict_resolution = "disabled"`: conflicted PRs stay conflicted until resolved by hand or via `devintern resolve-conflicts <pr-url>`.

## CI failures on the agent's PRs

Set `[workspace].ci_failure_fix = true` to watch GitHub Actions and commit statuses on every open PR the worker created and ask the agent to repair failures. The switch is off by default because each repair spends agent tokens and can push a commit. It live-reloads with `workspace.toml`.

For experimental GitLab code-host profiles, the same switch watches pipelines, required jobs, job traces, and external commit statuses on registered MRs. `allow_failure` jobs and manual, skipped, or canceled work do not trigger repair; unavailable or incomplete CI information remains unknown instead of being treated as success. GitLab CI is polling-only and uses the configured code-host token and instance.

The watch is continuous while the worker and PR remain open, not just when the PR is created. It runs once at worker startup and then every `[defaults].poll_interval` seconds, survives restarts through the workspace database, and stops when the PR closes, its repository leaves the workspace, or the setting is disabled. Only PRs recorded in the local `agent_prs` registry are watched; similarly named PRs created elsewhere are not discovered automatically.

Only completed `failure` and `timed_out` workflow runs, plus failed legacy commit statuses, trigger repair. The worker waits while any workflow is pending before declaring CI green, deduplicates successful repair runs by head SHA and workflow-run or status ID, and retries failed/no-op invocations up to `CI_FIX_MAX_ATTEMPTS` (default 3). After exhaustion it comments on the PR and waits for a human push or a green result before resetting the budget. Failing Actions job logs are reduced to an error-focused excerpt.

Pending, failing, and not-yet-reported CI is checked at the configured workspace poll interval. Once a PR's CI is terminal green and remains unchanged, the watcher progressively backs off that PR to 5, 15, and then 30 minutes. An observed PR or CI change returns it to the configured interval, and a worker restart performs an immediate reconciliation. The worker continues checking green PRs while they remain open so delayed reruns and newly added workflows are still detected.

Relay-backed workspaces perform these API calls with the local `GITHUB_TOKEN`. A fine-grained token—or the customer-owned App used by a no-relay worker—needs **Actions: Read** and **Commit statuses: Read** in addition to the normal PR and contents permissions. Existing App installations must be re-approved after adding permissions. No extra webhook event subscription is required because CI is polled. GitHub does not currently expose its separate Checks permission for fine-grained PATs, so check-run-only CI providers are not watched unless they also publish a commit status; GitHub Actions is fully supported through the Actions API.

## Mention the bot on any PR

The worker also reacts to mentions on pull requests it did not create. When a teammate writes a comment like `@devintern address the review feedback` on any PR in the repository, the worker picks it up on the next poll and handles it through the same pipeline. Detection is a repository-wide sweep of new comments (two requests per interval, regardless of how many PRs are open), so mentions work without any webhook setup.

Guardrails apply before the agent acts:

- Only users with push access (write, maintain, or admin) can direct the agent. Mentions from read-only users and non-collaborators are ignored, and the check fails closed on errors.
- Fork PRs are skipped with an explanatory comment unless the PR allows maintainer edits.
- The worker never force-pushes; if a human pushed to the branch meanwhile, the push is rejected instead of overwriting.
- Mentions posted before the worker first started are not dug up.

In the standard setup, pair the workspace with the relay and install the central DevIntern AI App. The worker recognizes `@devintern-ai` and uses your local `GITHUB_TOKEN` to fetch the comment, enforce the permission gate, and perform changes. No `GITHUB_APP_ID` or private key is stored locally. Without the relay, configure a customer-owned App for mention identity; see [GitHub authentication](./configuration.md#advanced-customer-owned-github-app).

## How events are handled

- Events are persisted to a local SQLite queue (`~/.devintern/state/queue.db`) before processing, so a crash or restart never loses accepted work.
- Runs interrupted by a dead worker are recovered on startup: their tickets get the failure comment and move back to To Do before new work is picked up.
- Duplicate webhook deliveries are detected by GitHub's delivery id and skipped.
- Review feedback is processed before new task pickup: a human waiting on feedback beats a ticket that can wait a minute.
- One task or scheduled automation runs at a time per repository.

## Instant events with the relay

Polling reacts within one interval (about a minute). On its default path, `worker init` offers to sign in and pair every GitHub and GitLab workspace repository with the [DevIntern relay](./relay.md), then connects the active tracker. Events reach the worker within seconds as reference envelopes (never code, comment content, or GitLab credentials). GitHub uses the central App; GitLab project hooks are created and tested locally when the token has Maintainer or Owner access. Multi-team polling uses isolated clients and cursors; use `worker connect <tracker> --team <name>` when one team owns that tracker type. Multiple teams using the same tracker type remain polling-only until relay envelopes carry team registration identity. Relay GitLab hints and periodic polling both re-fetch authoritative state for exact DevIntern-registered MRs. If relay delivery stops—or hook setup is unavailable—polling continues. Run `worker connect` after adding repositories or to repair or rotate code-host/tracker registrations.

## Seeing what the worker did

Every run is recorded stage by stage in the local database. The worker serves the [observability dashboard](./dashboard.md) on the loopback-only address `http://localhost:4400` by default; set `[workspace].dashboard = false` to disable it, or `[workspace].dashboard_port` to change the port. You can also run `devintern dashboard` standalone at any time (it works with the worker stopped too). If the dashboard port is unavailable, the worker logs a warning and continues processing.

## Running as a service

The worker runs identically on a laptop, VM, or container. When `devintern worker init` reaches its final step, it offers to install and start the service for you:

- **Linux**: the unit is installed into `~/.config/systemd/user/`, then `systemctl --user daemon-reload` plus `systemctl --user enable --now devintern-worker` run automatically. The unit uses the user manager's `default.target`, records the current executable `PATH`, invokes the Bun runtime directly, and enables user lingering so it starts after reboot without waiting for login. If lingering cannot be enabled, the running service is kept and the wizard prints the remaining command.
- **macOS**: the agent is installed into `~/Library/LaunchAgents/` and started with `launchctl bootstrap gui/$(id -u)` (with a `launchctl load -w` fallback on older hosts). It records the current executable `PATH`, invokes Bun directly, and is accepted as healthy only when launchd reports a running process.

If any step fails — a missing systemd user session (WSL, some containers), a headless host without launchd, or a command error — the wizard reports the error, restores the previous state (a freshly written definition is removed; an existing one is put back and reloaded), and prints the manual install commands so nothing is left half-installed. Declining the offer prints the same manual path. Pass `--no-service` to skip the step entirely.

Re-running `worker init` detects an existing DevIntern-managed service and offers to update and restart it in place instead of installing a duplicate. A hand-written definition is never overwritten; the wizard leaves it running and writes the proposed definition into the workspace for manual comparison. On Linux, the automatic setup enables lingering; if the host rejects that step, run once:

```bash
loginctl enable-linger
```

Running `devintern worker` in a terminal remains fully supported and is the only option on Windows, which has no generated service definition. For pm2 and tunnel setups (advanced webhook mode), see the [GitHub Integration guide](./github-integration.md). If you want the resident daemon idle during parts of the day, configure [working windows (quiet hours)](#working-windows-quiet-hours) instead of wrapping the CLI in cron.

## Worker Pilot and licenses

The no-card **Worker Pilot** lets a signed-in user evaluate the unattended product for 14 days with no task-count limit. It begins only after workspace validation succeeds and the worker is ready to start its event sources. Run `devintern login`, then `devintern worker`; creating an account or using the free interactive CLI does not consume trial time.

After the pilot, the worker requires an automation license (Supporter, Team, or Business). It revalidates access while running. If access expires, in-flight work may finish but event sources pause before acquiring more work; adding a license lets them resume on the next check. Paid `LICENSE_KEY` use does not require login, and interactive runs stay free under the FSL license.
