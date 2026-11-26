---
title: "Worker Dashboard"
sidebarLabel: "Dashboard"
description: "Use when checking what the worker is doing, reading agent transcripts, diagnosing failed runs, retrying work, or delegating an ad-hoc task from the local dashboard."
section: "Automation"
order: 4
dateModified: 2026-11-26
---

# Worker Dashboard

The dashboard shows what the worker has been doing: current and past runs, agent transcripts, failures, and queued work. It starts with `devintern worker` at [http://localhost:4400](http://localhost:4400) on the worker machine.

| Page            | What it shows                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| **Overview**    | Worker health, active and queued work, recently finished tasks. The landing page.                              |
| **Inbox**       | Notifications: what needs you, and what DevIntern changed outside itself. See [Inbox](#inbox).                 |
| **Runs**        | Full run history, filterable by status, origin, and [outcome class](#why-a-run-did-not-succeed). Open a run to follow its stages, read each agent transcript, open the task or PR, retry, or report a problem. |
| **Automations** | Recurring automations, estimations, and scheduled jobs, with **Run now**.                                      |
| **Pull requests** | The agent's PRs, switchable between **Open** (awaiting review, oldest first) and **Merged** (up to the 50 most recently merged, newest first), each linked to its ticket. Merges are recorded when the worker sees them, so PRs merged before this feature and PRs closed without merging are not listed. |
| **Workspace**   | A read-only view of `workspace.toml`: routing, repositories, automations, credentials (key names only), and policy. |
| **Stats**       | Success rates, durations, and **When runs happen**, a weekday × hour heatmap. Use it to move automations into quiet hours. Success and escalation rates and the median duration exclude auto-merge decisions, which are shown on their own line. |

## Check worker health

**Overview** shows:

- **Uptime, working window, and queue mix**: how long the worker has been up, when its working window opens or closes, and what is queued.
- **Active work**: runs in progress against `max_concurrency` and `max_concurrency_per_repo`. Every in-progress run counts, including PR review, CI fix, and conflict runs.
- **Agent harnesses**: your `AGENT_HARNESS` failover chain, which one is active, and any usage-limit window with its end time. After a limit ends, a harness reads **quota unconfirmed** until a run on it succeeds.
- **Tracker sources**: when each team's tracker was last polled. A source that missed more than three poll intervals is flagged.
- **Automation source health**: when an error monitor such as Sentry cannot be read, the header shows **N sources need attention** with a link to the details. See [Sentry integration](./sentry-integration.md#source-health-in-the-dashboard).

**Workspace** also says whether the running worker has applied the latest `workspace.toml`. A save that changes a restart-only setting (default tracker, a team's name, tracker, or env, error monitors, dashboard port, or working-hours schedule) is rejected as a whole, and the page shows why.

### Follow active work

Each **Active work** row shows the task, repository, harness, attempt, current phase and step, and elapsed time. Select a row to open the run. When the worker is stopped or every harness is usage-limited, rows turn neutral because the runs are not advancing.

Below the running rows:

- **Waiting to retry**: tasks deferred in the last 48 hours, for example after a usage limit, with the reason.
- **Queued**: accepted work that has not started, such as ad-hoc tasks, dashboard retries, PR events, automations waiting for their repository's checkout, and PR jobs (shown as `owner/repo#N`) waiting for a free slot or for another job on the same PR. Expand a row for its details: task key, repository, who queued it, when, why it may be held back, and for ad-hoc tasks the prompt. Expanding a pending ad-hoc task shows **Cancel task**: confirm it and the task is withdrawn before the worker starts it. If the worker started it in the meantime, the dashboard says it already started and changes nothing. Recently cancelled tasks are listed below the queue with who cancelled them and when. See [Cancel a pending task](delegation.md#cancel-a-pending-task).
- **Recently finished**: the last five finished tasks with outcome and PR. **View all runs** opens **Runs**.

## Inbox

The bell in the header shows how many notifications are unread; a `!` on the count means some of them need you. Open it for the latest items, or choose **Open inbox**. When something needs you, **Overview** also lists it in a **Needs you** block at the top, with the count split into what needs attention and what is waiting on review, for example **2 need attention · 5 waiting on review**.

| Tab                    | What lands there                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| **Needs you**          | Everything below that needs a human, plus exhausted retries, broken automations, and unreadable sources or credentials. |
| **DevIntern problems** | A DevIntern step failed (a likely DevIntern bug). The same error across runs shares one row, for example **Likely DevIntern bug: verify failed (×3)**. |
| **Waiting on review**  | Escalations: a review or merge rule held a PR for you, or the agent could not finish a task.     |
| **Activity**           | PRs DevIntern opened or auto-merged, and work a run delegated or tickets it filed.                |
| **All**                | Everything.                                                                                       |

Repeats of the same event share one row with a count such as **×88**, and the row comes back as unread when it happens again. Each row links to its run, PR, or ticket. On a delegated-work row, **Show spawned work** lists the child tasks and tickets with their current status.

- **Mark read** clears the unread state. **Mark all read** does it for every row.
- **Resolve** closes a row you have dealt with. Rows also resolve on their own when the problem goes away, for example when a later run of the same task succeeds. Turn on **Show resolved** to see them again.
- **Mute** hides this row and every future notification from the same cause. Use it for a known, noisy problem you do not want to hear about. Muted groups are listed at the bottom of the inbox with **Unmute**.

To get these on your desktop, in Slack, or at a webhook without keeping the dashboard open, see [Notifications](notifications.md).

## Why a run did not succeed

A run that failed, escalated, or was abandoned has an outcome class. The runs list shows it as a badge with the cause underneath, and **Class** filters by it. Open the run for a banner with the class, the step that failed, its error, and where the unfinished work went.

| Class                 | Meaning                                                                                  | What to do                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Waiting on review** | A review or auto-merge rule wants a human to approve, for example a version bump or a deny pattern. Nothing is broken. | Review the PR, then merge or close it.                                       |
| **Agent stopped**     | The agent could not complete the task: it gave up, tests kept failing, or the ticket was unclear. | Clarify the ticket or fix the blocker, then retry.                           |
| **DevIntern problem** | A DevIntern step failed rather than the agent's work: verification, git or worktree operations, PR creation, or a crash. | Retry. If it happens again, choose **Report problem** on the banner; the report is pre-filled with the step and error. |
| **Environment**       | Credentials, sign-in, network, a rate limit, a missing tool, or a code host that refuses the PR for a setup reason (for example missing code-host settings) stopped the run. | Fix the setup (see [Configuration](configuration.md)), then retry.           |

The banner also shows the work status: **Work saved on branch** (a retry continues from it), **Work kept in worktree** with its path on the worker machine, or **Work discarded** when the changes could not be saved. Runs from before this feature have no class, except escalated auto-merge runs, which show as **Waiting on review**.

## Retry a failed run

Fix the cause first (missing credentials, unclear task details, a temporary agent failure), then open the run and choose **Retry**. The worker queues a fresh attempt with the same routing and checks for queued retries every 5 seconds (`WORKER_RETRY_INTERVAL_SECONDS`). A run that already has an attempt queued or running cannot be retried again.

Ad-hoc tasks from `devintern worker add` show **Re-queue task** instead. It resumes the prior attempt on its existing branch rather than opening a second PR. It is also offered on a successful run that pushed its branch but failed to open the PR (for example on bad credentials); the re-queued run opens the PR from that branch. A fresh branch is used only when the old branch is gone or its PR was merged or closed. The worker also resumes an interrupted ad-hoc task once on its own at startup when there is work to resume. If a task cannot be re-queued, for example because its queue entry expired after 30 days, the run explains why; use `devintern worker add` to submit it again.

## Report a problem with a run

When a run fails in a way the output does not explain, or completes with the wrong result, open it and choose **Report a problem**. It files the same redacted bug report as `devintern report --run <id>`; see [Reporting Bugs](reporting-bugs.md#report-from-the-dashboard).

Missing credentials, usage limits, and failed verification checks are configuration issues, not DevIntern bugs. Fix those and retry. A run classed as a **DevIntern problem** shows **Report problem** on its banner instead, with the failing step and error already filled in.

For a problem that is not tied to one run, choose **Report a bug** at the bottom of the sidebar. It sends your environment and recent worker logs, with no run attached. **Request a feature** opens a public GitHub issue form with your version filled in.

## Run an automation now

Open **Automations**, find the automation, and choose **Run now**. It runs through the same pipeline as a scheduled occurrence. Use this to test a new prompt or to run routine work early. Open an automation to read its prompt, schedule, next run, and recent runs.

An automation runs in its repository's base checkout, which only one job uses at a time. If the checkout is busy, the automation shows **Waiting for a slot** and starts on its own when the checkout is free.

**Automations** also lists other scheduled jobs, each with **Run now**:

- **Estimation**: your `[[estimations]]` story-point sweeps, with the usual skip rules. See [Story Points Estimation](./story-points-estimation.md).
- **Conflicts** (when `[workspace].conflict_resolution = "scheduled"`): opens the conflict-resolution window now, for the usual grace period (`WORKER_RESOLVE_WINDOW_GRACE_MINUTES`). The next scheduled window does not move.
- **Auto-merge** (when `[workspace].auto_merge = true`): checks every open agent PR now. The PR must still be green and conflict-free.

**Run now** needs a running worker. A standalone `devintern dashboard` lists automations but cannot run them.

## Delegate a task

Choose **New task** in the header to hand the worker a one-off task, the dashboard equivalent of [`devintern worker add`](delegation.md). Pick a registered repository (and, when several teams are fixed to it, the team whose credentials the run uses, like `--team`), give it a title, and describe the work in Markdown (up to 20,000 characters). The worker sees only this text, so [write a self-contained brief](delegation.md#write-a-self-contained-brief). Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (<kbd>⌘</kbd>+<kbd>Enter</kbd> on macOS) to submit.

The task is queued and the running worker picks it up on its next poll. Ad-hoc tasks ignore [working windows](worker.md#working-windows-quiet-hours) and use `[defaults].worker_task_args` (default `--create-pr`). The dialog shows the task key (`local-<slug>`) and links to the run once it starts. Submitting twice returns the task that is already queued instead of creating a duplicate.

**New task** needs a workspace with at least one registered repository; add one with `devintern worker add-repo`.

For scripts, use [`devintern worker add`](delegation.md). It needs no running dashboard and can wait for the result. To call the API directly, send an `Origin` header that matches the address you call (see [Local by design](#local-by-design)):

```bash
curl -s http://127.0.0.1:4400/api/tasks \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:4400' \
  -d '{"repo":"backend","title":"Bump the lockfile","body":"","idempotencyKey":"lockfile-1"}'
```

The response matches `devintern worker add --json`: `{ id, taskKey, repo, status, deduplicated }`.

## View the dashboard without the worker

```bash
devintern dashboard
```

This shows existing run history while the worker is stopped. Only explicit actions such as **Retry**, **New task**, and **Cancel task** write anything.

| Option                      | Default     | Effect                                                                                     |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `--port <number>`           | `4400`      | Listen on another port (env: `DASHBOARD_PORT`).                                            |
| `--host <host>`             | `127.0.0.1` | Loopback address to bind: `127.0.0.1`, `localhost`, or `::1`.                              |
| `--workspace <path>`        | `~/.devintern` | Pass the same `workspace.toml` (or its directory) you gave the worker, so queue counts, automations, and transcripts follow it. |
| `--allow-origin <origin>`   |             | Trust an extra origin; repeatable. See [Allowed origins](#allowed-origins).                |
| `--no-tailscale-autodetect` |             | Do not trust Tailscale Serve origins automatically.                                        |

Starting a standalone dashboard requires an active Worker Pilot or automation license. The dashboard inside the worker stays available when an expired Worker Pilot pauses new work.

## Read dashboard data from the command line

Every read-only dashboard view is also a `devintern worker` subcommand. These commands read the workspace database directly, so they need no running dashboard or worker and no network access. Use them in scripts and from sandboxed agents, which usually cannot reach `localhost:4400`.

| Command                                   | Shows                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `devintern worker runs`                   | Recorded runs, newest first. Filter with `--automation`, `--origin`, `--status`, `--task-key`, `--limit`, `--offset`. |
| `devintern worker runs show <id>`         | One run with its stages, retry status, harness logs, and artifacts    |
| `devintern worker runs logs <id> [name]`  | A run's agent transcripts, or the redacted tail of one                |
| `devintern worker runs artifacts <id> [artifact-id]` | A run's artifacts, or one artifact's content               |
| `devintern worker stats`                  | Success rates, durations, and activity by hour (`--window 7d\|30d\|90d\|all`, default `30d`; `--tz <zone>`). Rates and the median duration exclude auto-merge decisions, which are shown on their own line |
| `devintern worker automations`            | Automations with next and last run                                    |
| `devintern worker prs`                    | PRs and MRs opened by the agent: open (default) or recently merged (`--state open\|merged`; `--limit N`, 1..500, default 50) |
| `devintern worker queue`                  | Queued work that has not started                                      |
| `devintern worker status`                 | Worker liveness, queue counts, poll cursors                           |
| `devintern worker overview`               | Capacity, harness health, tracker freshness                           |
| `devintern worker logs`                   | Recent worker log entries (`--lines N`, default 500; `--level`)       |

With `--json`, a command prints exactly the body of the matching dashboard API route (for example `worker runs` matches `GET /api/runs`), so scripts that used `curl` can switch unchanged:

```bash
devintern worker stats --window 7d --json | jq '.stats.successRate'
```

The commands use the workspace from `--workspace`, then `DEVINTERN_WORKSPACE_DIR`, then `~/.devintern`. They never modify the database. If it is missing or unreadable, the command prints why and exits with code `1`.

## Local by design

The dashboard listens only on a loopback address and cannot be bound to another one. It has no login of its own, and its actions retry runs, trigger automations, enqueue and cancel tasks, and send bug reports with your credentials.

To protect it from other websites open in your browser, the API accepts requests only for `localhost`, `127.0.0.1`, `[::1]` (any port), or an [allowed origin](#allowed-origins). Actions must come from the same origin as the dashboard page and send `Content-Type: application/json`.

To disable the dashboard or change its port:

```toml
[workspace]
dashboard = false
# dashboard_port = 4400
```

## Access the dashboard from another device

Keep the dashboard on loopback and put something that authenticates in front of it. Run transcripts, logs, and artifacts can contain credentials or customer data, so do not expose the port without a login.

| Option                        | Best for                               | Setup                                                                                                   |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| SSH tunnel                    | Another computer                       | `ssh -N -L 4400:127.0.0.1:4400 you@worker-host`, then open `http://localhost:4400`. Any local port works. |
| Tailscale Serve               | Phone and multiple devices             | `tailscale serve --bg 4400`, then open the `https://<machine>.<tailnet>.ts.net/` URL it prints.          |
| Reverse proxy with a login    | A fixed address on an internal network | Proxy to `127.0.0.1:4400` with authentication, and add the proxy's address to `allowed_origins`.         |

Tailscale Serve origins are detected and trusted automatically. Limit who can reach the machine with [Tailscale ACLs](https://tailscale.com/kb/1018/acls). Do not use `tailscale funnel`, which publishes the dashboard on the public internet with no login.

A reverse proxy example with Caddy basic auth (generate the hash with `caddy hash-password`):

```caddyfile
http://192.168.1.50:8088 {
	basic_auth {
		you $2a$14$REPLACE_WITH_OUTPUT_OF_CADDY_HASH_PASSWORD
	}
	reverse_proxy 127.0.0.1:4400
}
```

Plain HTTP sends the password and data unencrypted, so use it only on a trusted network, or add `tls internal` with an `https://` address.

### Allowed origins

An allowed origin is a full `scheme://host[:port]` the dashboard trusts in addition to loopback, such as a reverse proxy address or a Tailscale name that was not detected. Matching is exact, with no wildcards. Set it in any of these places; the lists are merged:

| Source                                                     | Example                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `workspace.toml` (worker and `devintern dashboard --workspace`) | `[dashboard]` `allowed_origins = ["http://192.168.1.50:8088"]`             |
| Environment variable (comma-separated)                     | `DASHBOARD_ALLOWED_ORIGINS=https://dash.example.internal,http://192.168.1.50:8088` |
| `devintern dashboard` flag (repeatable)                    | `--allow-origin https://dash.example.internal`                                  |

Restart the worker after changing `[dashboard]`. A malformed entry stops startup with an error that names it.

To turn off Tailscale detection, set `[dashboard].tailscale_autodetect = false` or `DASHBOARD_TAILSCALE_AUTODETECT=0`, or pass `--no-tailscale-autodetect`.

Allowed origins do not authenticate anyone. Who can reach the address is still up to your SSH access, Tailscale ACLs, or proxy login.

## Artifacts

Run detail lists the files a run registered, with the step and commit that produced them. Preview text, Markdown, and images, or download the files. See [Pipeline artifacts](./artifacts.md).
