---
title: "Delegate Tasks to the Worker"
sidebarLabel: "Delegate Tasks"
description: "Use when a coding agent or script should hand agreed implementation work to a running DevIntern worker with `devintern worker add`, without creating a tracker ticket."
section: "Automation"
order: 1.5
dateModified: 2026-11-18
tags: ["worker", "delegation", "worker-add", "agents", "automation", "ssh", "remote"]
---

# Delegate Tasks to the Worker

Delegation hands a piece of agreed implementation work to a DevIntern worker that is already running on your machine. `devintern worker add` enqueues a one-off task against one registered workspace repository. The worker picks it up on its next poll and runs it through the full pipeline (checkout in a separate worktree, agent, PR, retries), just like a tracker ticket. The calling agent does not need to stay in the loop unless it chooses to wait.

To delegate by hand without a terminal, use **New task** in the [dashboard](dashboard.md#delegate-a-task). It takes the same repository, title, and Markdown description, applies the same validation and idempotency rules, and returns the same task key and status.

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
| `--json`                   | Emit a single `{ id, taskKey, repo, status, deduplicated }` object on stdout (failed `--wait` runs add an `error` field; see [JSON output](#json-output) for `harnessPausedUntil`) |
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
emits a single object: the settled state, with `error` carrying the task's
failure reason when it failed, or a `status: "failed"` object with an `error` on
a timeout/worker-stop/inconclusive wait, not an interim pending object plus a
final one. Successful results have no `error`. Without `--json`, diagnostics and
the result line print to stdout as usual.

### When every agent harness is usage-limited

While every harness in the worker's `AGENT_HARNESS` chain (the workspace `.env`
wins over the process environment) has an open usage-limit window persisted in
`queue.db`, the worker defers all new agent work and the task cannot start yet.
`worker add` still enqueues the task and exits `0`, but instead of "The worker
picks it up on its next poll." it prints:

```text
⏳ Every agent harness in AGENT_HARNESS (opencode) is usage-limited until 2026-11-20T04:00:00.000Z; the worker starts this task after that.
   Add a fallback harness (e.g. AGENT_HARNESS=opencode,codex in ~/.devintern/.env) to keep working through limits.
```

The reset time is the earliest open window, the moment the worker resumes. With
`--json` these lines go to stderr and the result object gains an
`harnessPausedUntil` field (ISO-8601 string with that same time). With `--wait`
and a non-zero `--wait-timeout` whose deadline ends before the reset, a further
warning says the wait will likely time out; the wait and its exit code are
unchanged, and a timed-out `--wait --json` object keeps `harnessPausedUntil`.
The same warning and field appear when an `--idempotency-key` hits a still
pending task and for `--resume` (re-queued or already pending). When at least
one chain entry is available, or the state cannot be read, the output is
unchanged and `harnessPausedUntil` is absent. Startup-failure cooldowns are not
persisted and are not considered.

Delegating agents should report a task with `harnessPausedUntil` as queued
behind a usage limit until that time, not as about to start.

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
  the daemon (paid automation license, or the no-card Worker Pilot). The
  dashboard's **New task** relies on the same check, which the dashboard runs
  when it starts.
- **Quiet hours.** Injected tasks are operator-initiated, so they bypass
  [working windows](worker.md#working-windows-quiet-hours) like
  `devintern worker run-now`; no extra `run-now` is required.
- **PR behavior.** Injected runs inherit `[defaults].worker_task_args` (default
  `--create-pr`), so they open a pull request just like tracker tasks. Dispatch
  can therefore start work immediately and open a PR.

## Delegate from another machine

`devintern worker add` writes to the worker's own `queue.db` and `injected/`
directory, so it must run on the machine that runs the worker. A coding agent
on your laptop, a cloud VM, or a colleague's machine can still delegate: it runs
the same commands on the worker host over SSH. This is plain command execution,
not port forwarding, so you do not need a tunnel, an open dashboard port, or a
DevIntern install on the calling machine.

### Set up access once

If the calling machine can already reach the worker host with SSH keys, skip to
[Check the connection](#check-the-connection).

If the two machines are on different networks (behind NAT, home and office, a
laptop and a cloud box), [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh)
is the shortest path. It needs no inbound port, port forwarding, or SSH key
management:

```bash
# on the worker host
tailscale up --ssh

# on the calling machine: sign in to the same tailnet, then
ssh you@worker-host 'devintern --version'
```

Tailnet identity is the access boundary. Use
[Tailscale ACLs](https://tailscale.com/kb/1018/acls) to limit which devices
and users may SSH into the worker host: anyone who can run commands there can
enqueue tasks that act with your repository credentials.

Optionally add a host alias so commands and agents can refer to the worker by
one name:

```sshconfig
# ~/.ssh/config on the calling machine
Host devintern-worker
  HostName worker-host        # or worker-host.<tailnet>.ts.net
  User you
```

### Check the connection

Non-interactive SSH commands often run without your login shell's `PATH`, so
`devintern` installed under `~/.bun/bin` may not be found. Check that both of
these work from the calling machine:

```bash
ssh devintern-worker 'devintern worker add --help'
ssh devintern-worker 'cat ~/.devintern/workspace.toml'
```

If `devintern` is not found, call it by absolute path
(`~/.bun/bin/devintern`), or add that directory to `PATH` in a file that
non-interactive shells read (for bash, the top of `~/.bashrc`, before any
early return for non-interactive shells).

### Dispatch over SSH

Pass the brief on stdin with `--body-file -` so the remote shell never parses
it. Keep the title in single quotes inside the remote command:

```bash
ssh devintern-worker "devintern worker add --repo backend \
  --title 'Fix checkout retry handling' \
  --idempotency-key checkout-retry-followup \
  --body-file - --json" < /tmp/devintern-task-UNIQUE.md
```

The `--json` result and exit code come back over SSH unchanged. Read the
outcome the same way:

```bash
ssh devintern-worker 'devintern worker runs --task-key <taskKey> --json'
ssh devintern-worker 'devintern worker runs show <id> --json'
ssh devintern-worker 'devintern worker logs --level warn'
```

A few things differ from a local handoff:

- **The worker uses its own checkout.** Commits, branches, and files that exist
  only on the calling machine are invisible to it. Push what the task depends
  on, or copy the needed findings into the brief.
- **`--workspace` paths are on the worker host.** Read `[[repos]]` from the
  worker host's workspace file, not from a local one.
- **Prefer short bounded waits.** A dropped SSH connection ends `--wait` on the
  calling side but not the task. Inspect `worker runs` before enqueueing again.

### Coding agents

The [devintern-delegate skill](agent-skills.md) supports a remote worker. Tell
the agent which SSH host runs the worker ("delegate this to DevIntern on
`devintern-worker`"), or set `DEVINTERN_WORKER_SSH=devintern-worker` in the
agent's environment. The skill then runs every workspace read and `devintern`
command on that host. `DEVINTERN_WORKER_SSH` is a convention for the skill; the
CLI itself does not read it.

### Dashboard API alternative

Callers that can make HTTP requests but cannot run SSH commands can use the
dashboard's `POST /api/tasks` endpoint through an SSH tunnel, Tailscale Serve,
or an authenticating reverse proxy. It takes the same fields and returns the
same result as `worker add --json`; see
[Delegate a task](dashboard.md#delegate-a-task) and
[Access the dashboard from another device](dashboard.md#access-the-dashboard-from-another-device).
It cannot `--wait`, and it needs the worker's dashboard to be running.

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
