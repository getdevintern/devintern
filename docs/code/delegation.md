---
title: "Delegate Tasks to the Worker"
sidebarLabel: "Delegate Tasks"
description: "Use when a coding agent or script should hand agreed implementation work to a running DevIntern worker with `devintern worker add`, without creating a tracker ticket."
section: "Automation"
order: 1.5
dateModified: 2026-11-12
tags: ["worker", "delegation", "worker-add", "agents", "automation"]
---

# Delegate Tasks to the Worker

Delegation hands a piece of agreed implementation work to a DevIntern worker that is already running on your machine. `devintern worker add` enqueues a one-off task against one registered workspace repository. The worker picks it up on its next poll and runs it through the full pipeline (checkout in a separate worktree, agent, PR, retries), just like a tracker ticket. The calling agent does not need to stay in the loop unless it chooses to wait.

Coding agents can install the [devintern-delegate skill](agent-skills.md), which follows the steps on this page: repository selection, self-contained briefs, idempotent submission, and bounded waiting for results.

## Before you delegate

- **A workspace with the repository registered.** The target repository must be a `[[repos]]` entry in the workspace (default `~/.devintern/workspace.toml`, or the path given by `--workspace` or `DEVINTERN_WORKSPACE_DIR`). Register a checkout with `devintern worker add-repo`; see [Workspaces](workspaces.md).
- **A worker with automation access.** The worker must run with the no-card Worker Pilot or a paid automation license. A task enqueued while no worker is running stays queued until one starts.
- **A CLI that supports the command.** Check `devintern worker add --help`. Older installations do not have `worker add`, or may lack some flags used below.

Missing workspace configuration, credentials, or automation access are setup issues. Fix them through [setup](quick-start.md) rather than changing worker policy to make enqueueing succeed.

## Pick the right `--repo`

`--repo` takes the registered `[[repos]]` name, not a directory name. Read the workspace's `[[repos]]` entries, find the one whose remote matches the repository you mean, and pass its `name`. A checkout's basename often differs from the registered name, so do not guess from the current directory. `--repo` may be omitted only in a one-repo workspace; with several repos, omitting it or passing an unknown name fails and lists the valid names.

## Write a self-contained brief

The worker does not inherit your chat, your uncommitted edits, or local-only files. The task body is all the agent will see, so include:

- the desired behavior and why it is needed;
- relevant files, symbols, and committed paths;
- acceptance criteria and scope boundaries (what not to touch);
- useful verification commands;
- accessible issue or PR URLs and revisions when they matter;
- any local findings the worker needs, copied into the brief itself.

Never include credentials. The body is limited to 20,000 characters. Prefer writing the brief to a unique temporary file and passing it with `--body-file` over interpolating a long prompt into a shell command; remove the file after `worker add` returns.

## When not to delegate

- The work was not agreed by the user, or goes beyond what they asked for.
- The change overlaps or depends on another pending task. Coordinate the order first; prefer independent tasks that can be reviewed separately.
- You are a worker agent already running an assigned task. Do not delegate your own implementation back into the worker unless you were explicitly asked to orchestrate further work.
- You need a tracker ticket. Creating tickets is a different workflow (`devpm`).
- The worker cannot run it: the CLI lacks `worker add`, or setup is incomplete. Report the blocker instead of silently switching to a foreground run.

## Dispatch

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

A typical agent handoff writes the brief to a file first:

```bash
devintern worker add --repo backend \
  --title 'Fix checkout retry handling' \
  --body-file /tmp/devintern-task-UNIQUE.md \
  --idempotency-key checkout-retry-followup --json
```

The task is materialized as a local markdown prompt in `~/.devintern/injected/`
and a durable row in the central DB, then picked up by the running worker on its
next poll. No `[[routing.rules]]` entry is needed because the row names its repo
explicitly. Tasks are attributed to the `local:add` source in worker logs, run
records, and the [dashboard](dashboard.md), and start on a `feature/local-<slug>` branch (the
`local-` prefix cannot collide with a tracker key).

## Options

| Option                     | Description                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--repo <name>`            | `[[repos]]` name to target (default: the only repo, else required)                                                              |
| `--title <text>`           | Task title (required unless `--resume`)                                                                                         |
| `--body <text>`            | Task description                                                                                                                |
| `--body-file <path>`       | Read the description from a file (`-` reads stdin)                                                                              |
| `--idempotency-key <key>`  | Dedupe key; while a task with the key is pending/running a retry reuses it, and once it settles the key starts a new occurrence |
| `--resume <taskKey>`       | Re-queue a settled ad-hoc task under its existing key (a failed or interrupted attempt resumes its branch and prior report)     |
| `--wait`                   | Block until the run finishes; exit `0` on success, `1` on failure                                                               |
| `--wait-timeout <seconds>` | Give up waiting after this long (default 21600 = 6h; `0` waits without a limit)                                                 |
| `--json`                   | Emit a single `{ id, taskKey, repo, status, deduplicated }` object on stdout (failed `--wait` runs add an `error` field)        |
| `--workspace <path>`       | Use this `workspace.toml` (default `~/.devintern/workspace.toml`, or `DEVINTERN_WORKSPACE_DIR`)                                 |

Validation happens before anything is written. An empty title, a body over
20,000 characters, a missing `--body-file`, and passing both `--body` and
`--body-file` are rejected. `--resume` takes no title, body, repo, or
idempotency key: the existing row already holds them, and an unknown task key
fails without writing anything.

## JSON output

With `--json`, stdout carries exactly one JSON object; every human/status line
(license notices, "Enqueued…", the `--wait` progress line) goes to stderr, so
`devintern worker add … --json | jq .` parses cleanly. `--wait --json` still
emits a single object: the settled state, or a `status: "failed"` object with an
`error` on a timeout/worker-stop/inconclusive wait, not an interim pending object
plus a final one. Without `--json`, diagnostics and the result line print to
stdout as usual.

Check the exit code as well as the object; validation failures may produce no
result object. The enqueue response does not include a PR URL. Confirm a PR from
the run artifacts or the dashboard before reporting one.

## Idempotency

A task carrying `--idempotency-key` is reused (reported as `deduplicated`) only
while an earlier task with that key is still pending or running, so a retried
automation cannot create a duplicate. Once that task settles, enqueuing the same
key starts a new task. A fixed key like `--idempotency-key nightly-docs`
therefore drives a recurring job without changing the key each run.

Use a stable key for retries of the same intended dispatch and different keys
for distinct work. Deduplication is not permanent exactly-once delivery, so do
not blindly resubmit after an ambiguous response; inspect the existing task
first.

## Waiting for the result (`--wait`)

The command returns after enqueue. Without `--wait`, success means the task was
durably enqueued, not implemented. Wait only when completion is needed for the
next step, and bound it, for example `--wait --wait-timeout 600`.

`--wait` is the scripting hook: it polls the row and exits with the run's
status. It fails fast only when a queued (`pending`) task has no worker that
could claim it; a task that was already `running` keeps waiting through a worker
restart so startup recovery can auto-resume it, but fails after a bounded
five-minute restart grace if no worker comes back. A `pending` task waits
through the same grace whenever a live replacement is starting (it will be
claimed), so a transient restart is not reported as a failure. The grace starts
only when no replacement process is starting: a replacement writes a startup
marker before its slow pre-lock work (orphan recovery, worktree sweep, push
probes), and while that process is alive its startup time does not count
against the grace (the overall `--wait-timeout` still bounds the wait). It exits
non-zero once the task settles `failed` (including an exhausted
automatic-resume budget) or when `--wait-timeout` (default 6 hours) elapses
without the task settling. A live worker that keeps deferring the task (a
usage-limit pause, a permanently saturated repo) can no longer make `--wait`
hang forever. Pass `--wait-timeout 0` to wait without a limit.

A timeout, worker stop, or inconclusive wait reports `status: "failed"` with an
`error` even though the task itself may still be queued or running. Inspect the
error and the existing run in the dashboard or worker logs before enqueuing
again. Do not edit the queue database or managed prompt files to retry or cancel
work.

## Resuming and interrupted tasks (`--resume`)

- **Durable.** Enqueue writes to `queue.db`, so a task survives worker restarts
  and runs on the next poll. If no worker is running the task is still queued
  (`worker add` says so) and `--wait` refuses to block. Settled rows are pruned
  after 30 days by default; set `WORKER_INJECTED_TASK_RETENTION_DAYS` to change
  that window.
- **Interrupted tasks are auto-resumed when it is safe.** A task left mid-run
  by a worker restart is inspected at the next startup. When its latest local
  run recorded a branch that still exists and the branch carries either an
  implementation report or commits ahead of the repo's base, the row returns to
  `pending` and the next run inherits that branch and report through session
  pickup; `--wait` keeps waiting across the restart and exits with the
  replacement run's outcome. Automatic resume is bounded to one per row by
  default (set `WORKER_INJECTED_AUTO_RESUME_LIMIT` to change it; `0` disables
  it), so a restart loop cannot re-run the task forever. When there is no safe
  state (no prior run, no recorded branch, no report and no landed commits, or
  the branch is gone), the row settles `failed` with
  `worker restarted while this task was running` instead of silently starting a
  fresh run. A row whose latest run had already succeeded (the worker died
  before settling the row) settles `done` instead, so `--wait` reports the
  successful PR and a later `--resume` does not start a second run. When the
  bound is exhausted the row fails with an actionable `--resume` message.
- **Explicit resume.** Re-queue a failed or interrupted task with
  `--resume <taskKey>` (or the dashboard's **Re-queue task**), which resets the
  automatic budget: the row keeps its key, so the retry targets the same
  `feature/local-<slug>` branch and session pickup hands the prior attempt's
  report to the agent (when it recorded one) instead of starting a second
  branch and PR. A task whose prior attempt already succeeded has no interrupted
  work to inherit, so resuming it starts a fresh attempt rather than reusing the
  prior branch and report. A task that never started is still `pending` and
  needs no resume.
- **A graceful shutdown does not launder a real failure.** Draining the worker
  aborts running task children; the aborted run is reported as _interrupted_,
  so its row stays `running` for the successor's startup recovery. A pipeline
  that fails on its own during the same shutdown window still settles `failed`
  with its real error and message; only an abort is treated as an unknown
  outcome.
- **Hard kills keep a live child out of the resume path.** Task children run
  detached and are stopped through the worker's shutdown signal. The worker
  records the spawned child pid _and its start time_ on the queue row, so after
  a `SIGKILL` or OOM kill startup recovery probes the pid (and its detached
  process group) before auto-resuming. If it is still alive, the row stays
  `running` and is re-checked at the next startup: that child is the same task,
  and re-queueing would force-remove its worktree and race a second agent on the
  same `feature/local-*` branch. A child that finishes successfully needs no
  resume; the next startup settles the row `done` from its run record. A pid
  whose live process started at a different time is treated as recycled (the OS
  reuses pids, and a reboot restarts the table), so it never blocks the row or
  tells you to kill an unrelated process. `--resume` and the dashboard
  **Re-queue task** refuse while the recorded child is still alive, and work
  again once it has exited.

## How the worker runs delegated tasks

- **Concurrency.** Pending ad-hoc tasks are claimed together and run in
  parallel up to the workspace's `max_concurrency` / `max_concurrency_per_repo`
  limits, sharing capacity with polled, review, and automation work. A task
  deferred because its repo is busy is requeued for the next poll without
  blocking independent repos behind it.
- **Harness deferrals.** A claimed task whose run is deferred because the
  agent harness chain was usage-limited or could not start is requeued with
  exponential backoff (1 minute, doubling, capped at 1 hour). After 24
  consecutive deferrals the task is settled `failed` with a message pointing
  at `devintern worker add --resume <taskKey>`, which re-queues it with a fresh
  budget.
- **Licensing.** Enqueuing automation work runs the same entitlement check as
  the daemon (paid automation license, or the no-card Worker Pilot).
- **Quiet hours.** Injected tasks are operator-initiated, so they bypass
  [working windows](worker.md#working-windows-quiet-hours) like
  `devintern worker run-now`; no extra `run-now` is required.
- **PR behavior.** Injected runs inherit `[defaults].worker_task_args` (default
  `--create-pr`), so they open a pull request just like tracker tasks. Dispatch
  can therefore start work immediately and open a PR.

## Sandboxed agents

Sandboxed agents can enqueue too: workspace runs grant write access to
`injected/`, `state/`, and `automations/`, so `worker add` works under
`AGENT_SANDBOX` without extra configuration. See the
[sandbox configuration](configuration.md#what-the-sandbox-allows) for the full list of grants.

## Report the outcome

When an agent delegates on someone's behalf, it should report the repository,
the task ID and key, whether the enqueue was new or deduplicated, and whether
the task is queued, completed, failed, or of unknown completion. Include a PR
URL only when it is confirmed by run artifacts or the dashboard.
