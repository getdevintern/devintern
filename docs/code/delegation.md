---
title: "Delegate Tasks to the Worker"
sidebarLabel: "Delegate Tasks"
description: "Use when a coding agent or script should hand agreed implementation work to a running DevIntern worker with `devintern worker add`, without creating a tracker ticket."
section: "Automation"
order: 1.5
dateModified: 2026-11-20
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
| `--team <name>`            | Run with this `[[teams]]` entry's credentials (default: the team fixed to the repo, if exactly one; required when several are)   |
| `--title <text>`           | Task title (required unless `--resume`)                                                                                         |
| `--body <text>`            | Task description                                                                                                                |
| `--body-file <path>`       | Read the description from a file (`-` reads stdin)                                                                              |
| `--idempotency-key <key>`  | Dedupe key; while a task with the key is pending/running a retry reuses it, and once it settles the key starts a new occurrence |
| `--after <taskKey>`        | Start only after this ad-hoc task (same repo) finishes; repeatable. See [Dependent tasks](./delegation-dependencies.md) |
| `--stack`                  | Dependency mode `stacked`: start on an unmerged dependency's branch once it succeeded (overrides `[defaults].dependency_mode`) |
| `--wait-merge`             | Dependency mode `merged`: wait until every dependency's PR merged (overrides `[defaults].dependency_mode`)                      |
| `--resume <taskKey>`       | Re-queue a settled ad-hoc task under its existing key; it continues the prior branch unless that branch is gone or its PR was merged or closed |
| `--wait`                   | Block until the run finishes; exit `0` on success, `1` on failure, `3` if the task was [cancelled](#cancel-a-pending-task) first |
| `--wait-timeout <seconds>` | Give up waiting after this long (default 21600 = 6h; `0` waits without a limit)                                                 |
| `--json`                   | Emit a single `{ id, taskKey, repo, status, deduplicated }` object on stdout (failed `--wait` runs add an `error` field; see [JSON output](#json-output) for `harnessPausedUntil` and the dependency fields) |
| `--workspace <path>`       | Use this `workspace.toml` (default `~/.devintern/workspace.toml`, or `DEVINTERN_WORKSPACE_DIR`)                                 |

The task runs with the repository's credentials, plus the `env_file` and `[teams.env]` of the team fixed to that repo (`repo = "<name>"`) or the team named with `--team`. The task stays a local task: only credentials come from the team, not its tracker. See [Environment](workspaces.md#environment).

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
final one. Successful results have no `error`. A task cancelled while you wait
reports `status: "cancelled"` with a `message` (and no `error`). Without `--json`, diagnostics and
the result line print to stdout as usual.


A task with dependencies also carries `dependsOn` (the stored keys) and
`dependencyMode` (`merged` or `stacked`, after `--stack` / `--wait-merge` and
`[defaults].dependency_mode` are applied). While it is pending and not yet
claimable, `dependencyState` (`waiting` or `blocked`) and `dependencyReason`
explain why.

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

## Dependent tasks (`--after`)

Queue work that depends on another ad-hoc task right away with `--after <taskKey>` (or a `Depends on:` line in the body); the worker holds it until its dependencies are far enough along. See [Dependent Delegated Tasks](./delegation-dependencies.md).

### Modes: merged and stacked

When `[defaults].dependency_mode` is not set, tasks for GitHub repos are stacked and tasks for other repos (GitLab, Bitbucket) wait for the merge. Override it per task with `--stack` or `--wait-merge`. See [Modes: merged and stacked](./delegation-dependencies.md#modes-merged-and-stacked).

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

Without `--wait`, success means the task was durably enqueued, not implemented. Wait only when the next step needs the result, and bound it, for example `--wait --wait-timeout 600`. See [Waiting for the result](./delegation-runs.md#waiting-for-the-result---wait).

## Cancel a pending task

Withdraw a task that has not started yet, for example one with the wrong repo,
a bad brief, or a duplicate:

```bash
devintern worker cancel local-fix-flaky-checkout-test --reason "wrong repo"
```

The task never runs: no branch, run, or PR is created for it. The dashboard's
**Cancel task** action in the Overview's **Queued** list does the same. Only
`pending` tasks can be cancelled, including ones held back by a usage-limit
pause or a dependency; a task the worker already started keeps running.

| Outcome (`--json` `outcome`) | Exit | Meaning                                                       |
| ---------------------------- | ---- | ------------------------------------------------------------- |
| `cancelled`                  | `0`  | Printed as `Cancelled <taskKey>`                              |
| `already_cancelled`          | `0`  | Cancelled earlier; the first cancel's time and actor are kept |
| `already_started`            | `1`  | The worker claimed it first; nothing changed                  |
| `already_finished`           | `1`  | It already settled `done` or `failed`; nothing changed        |
| `not_found`                  | `1`  | No ad-hoc task with that key in this workspace                |

`--json` prints one `{ taskKey, outcome, message }` object. `--reason <text>`
(up to 500 characters) is recorded with the cancel time and who cancelled it
(`cli` or `dashboard`); `devintern worker queue` and the dashboard list
recently cancelled tasks with those details. A cancelled task frees its
`--idempotency-key` for a new task, cannot be restarted with `--resume` (enqueue
it again instead), and is pruned with other settled tasks after the retention
window. A task that depends on a cancelled one stays blocked.

## Resuming and interrupted tasks (`--resume`)

Re-queue a failed or interrupted task with `--resume <taskKey>`; it continues on the same branch and PR. For automatic resume after a worker restart, concurrency, and retries, see [Wait for and Resume Delegated Tasks](./delegation-runs.md#resuming-and-interrupted-tasks---resume).

## Delegate from another machine

`devintern worker add` must run on the machine that runs the worker. A coding agent elsewhere can run the same commands on the worker host over SSH, or call the dashboard API. See [Delegate from Another Machine](./delegation-remote.md).

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
