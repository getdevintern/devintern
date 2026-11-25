---
title: "Wait for and Resume Delegated Tasks"
sidebarLabel: "Delegated Task Runs"
description: "Use when a script waits on a delegated task with `--wait`, re-queues one with `--resume`, or needs to know how the worker runs, retries, and recovers delegated tasks."
section: "Automation"
order: 1.8
dateModified: 2026-11-20
tags: ["worker", "delegation", "worker-add", "wait", "resume"]
---

# Wait for and Resume Delegated Tasks

Part of [Delegate Tasks to the Worker](./delegation.md).

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

From inside a PID-isolated sandbox (for example an agent running under
bubblewrap `--unshare-pid`), the worker's pid is invisible, so `worker add`
cannot verify the worker. It prints "Could not verify the worker from this
sandbox; the task is queued durably." instead of claiming no worker is running,
allows `--wait`, and treats the worker as alive while waiting. The worker
refreshes a heartbeat in its lock every 20 seconds; once that heartbeat is more
than 2 minutes old, the worker counts as stopped, so `--wait` on a crashed
worker still fails after the restart grace instead of blocking until
`--wait-timeout`. Likewise, a replacement's startup marker written from another
PID namespace counts as a starting worker only for its first 2 minutes; after
that the restart grace applies.

Restart the worker after upgrading so its lock records its PID namespace.
A worker started on an older version writes a lock without a namespace or
heartbeat. From inside the sandbox its pid is then probed directly and is not
found, so `worker add` reports that no worker is running and refuses `--wait`.

A timeout, worker stop, or inconclusive wait reports `status: "failed"` with an
`error` even though the task itself may still be queued or running. Inspect the
error and the existing run in the dashboard or worker logs before enqueuing
again. Do not edit the queue database or managed prompt files to retry or cancel
work.

If the task is [cancelled](./delegation.md#cancel-a-pending-task) while you wait, `--wait`
returns within one poll (about a second), prints that the task was cancelled,
and exits `3`, so scripts can tell a withdrawn task from a failed run (`1`).

## Resuming and interrupted tasks (`--resume`)

- **Durable.** Enqueue writes to `queue.db`, so a task survives worker restarts
  and runs on the next poll (every 5 seconds; set
  `WORKER_INJECTED_INTERVAL_SECONDS` to change it). If no worker is running the task is still queued
  (`worker add` says so) and `--wait` refuses to block. Settled rows are pruned
  after 30 days by default; set `WORKER_INJECTED_TASK_RETENTION_DAYS` to change
  that window. Pruned outcomes remain available to `--wait` for 24 hours after
  the row is removed, then the next hourly sweep deletes them.
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
  branch and PR. The same applies when the prior attempt succeeded but did not
  finish delivery: a branch that was pushed without a PR (for example because
  PR creation failed on credentials) is checked out again and the PR is opened
  from it, and a branch whose PR is still open keeps working on that PR. The
  agent is told to verify the inherited work and not redo it. A fresh
  `-attempt-N` branch is used only when the prior branch is gone, has no
  commits, or its PR was merged or closed. Checking whether a PR is still open
  works on GitHub; on other code hosts, or when the check fails (for example an
  expired token or a rate limit), a recorded PR starts a fresh attempt. A
  task that never started is still `pending` and needs no resume. A
  [cancelled](./delegation.md#cancel-a-pending-task) task cannot be resumed.
- **Unfinished work is saved.** When a worker run fails or is handed back
  (`escalated`) after the agent started implementing, uncommitted changes are
  committed to the task branch as a `wip(<taskKey>)` commit and the branch is
  pushed (never force-pushed), so `--resume` continues from it. The run's
  outcome in `worker queue` and the dashboard names the branch. If the push
  fails (for example someone else pushed to that branch), the worktree is kept
  and the outcome shows its path instead.
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
  the daemon (paid automation license, or the no-card Worker Pilot). The
  dashboard's **New task** relies on the same check, which the dashboard runs
  when it starts.
- **Quiet hours.** Injected tasks are operator-initiated, so they bypass
  [working windows](worker.md#working-windows-quiet-hours) like
  `devintern worker run-now`; no extra `run-now` is required.
- **PR behavior.** Injected runs inherit `[defaults].worker_task_args` (default
  `--create-pr`), so they open a pull request just like tracker tasks. Dispatch
  can therefore start work immediately and open a PR.
