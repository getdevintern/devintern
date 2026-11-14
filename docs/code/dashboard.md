---
title: "Worker Dashboard"
sidebarLabel: "Dashboard"
description: "Use when checking what the worker is doing, reading agent transcripts, diagnosing failed runs, retrying work, or delegating an ad-hoc task from the local dashboard."
section: "Automation"
order: 4
dateModified: 2026-11-14
---

# Worker Dashboard

The dashboard answers a simple question: **what has the worker been doing?** It gives you a local view of current and past runs without making you read terminal output or inspect the worker database.

It starts automatically with `devintern worker`. Open [http://localhost:4400](http://localhost:4400) on the machine running the worker. The page opens on **Overview**; run history is under **Runs**.

## What you can do

- Check worker health at a glance on **Overview**: running work against your concurrency limits, agent harness quota, and tracker polling
- Review your connected trackers, routing, repositories, and automations on **Workspace** without opening `workspace.toml`
- See whether the worker is running, waiting for its next working window, or processing a task
- See how much work is waiting in the status strip, including queued ad-hoc tasks and scheduled retries as well as relay deliveries
- Follow each run from task pickup through implementation and pull request creation
- Read the raw agent transcript for any harness execution under the run (clarity, implementation, review, and more)
- Open the task or pull request behind a run
- Understand why a run failed and retry it after fixing the cause
- Run a recurring automation immediately instead of waiting for its next scheduled time
- Hand the worker a one-off task with **New task**, without creating a tracker ticket
- Review recent worker logs when something needs attention

The overview also summarizes activity and success rates, which is useful for spotting repeated failures without checking every run individually.

## Check worker health

**Overview** is the landing page. It shows:

- **Uptime, working window, and queue mix.** How long the worker has been up, when its working window opens or closes, and what kind of work is queued (webhook deliveries, ad-hoc tasks, scheduled retries).
- **Active work.** Runs in progress against `max_concurrency`, with a per-repository breakdown against `max_concurrency_per_repo`. The count includes every in-progress run, including PR review, CI fix, and conflict runs. See [Follow active work](#follow-active-work) for the rows underneath.
- **Agent harnesses.** Your `AGENT_HARNESS` failover chain in priority order, which harness is active, and any usage-limit window with the time it ends. When every harness is limited, a banner shows when agent work resumes. After a limit window ends, the harness reads **quota unconfirmed** until a run on it succeeds, because the worker only learns the quota is back when an agent run goes through. The header shows the same warning on every page.
- **Tracker sources.** Each team's tracker and when it was last polled. A source that has not polled for more than three poll intervals is flagged.

Startup-failure cooldowns are kept in worker memory only, so the dashboard does not show them.

### Follow active work

Under the capacity meter, **Active work** lists every run in progress, longest-running first. Each row shows the task title (or its ticket key), the repository, harness, and attempt number, then a phase (Preparing, Assessing, Implementing, Reviewing, or Publishing) with its position in the pipeline, the exact step underneath (for example verify or repair 2, or "between steps"), and elapsed time. Select a row to open its run details.

Step tracking follows the task pipeline, including preparation, feasibility, implementation, commit, auto-review, publication, and custom steps. Repeated steps update their start time. Between steps, the row names the last step explicitly. Older runs and workflows that do not use the task step runner show **Step not recorded**; the dashboard never guesses the current step from a completed stage.

When the worker is stopped or every agent harness is usage-limited, in-progress runs are not advancing. Their rows turn neutral, stop pulsing, show when they started instead of a running clock, and say why in a tooltip. A run interrupted before recovery may still be recorded as in progress until the worker reconciles its history.

Two lists sit below the running rows:

- **Waiting to retry** appears only when a task's latest attempt was deferred in the last 48 hours (for example after an agent usage limit), with the reason and the step it stopped at.
- **Recently finished** is collapsed by default and holds the last five finished tasks with their outcome and pull request. **View all runs** opens the full history in **Runs**.

Repeat attempts at the same task are folded into one row. The former **Task activity** page now lives here; old `#/activity` links open **Overview**.

## Review your workspace configuration

**Workspace** is a read-only view of `workspace.toml`:

- **Work routing.** Which tracker source, automation, or error monitor sends work to which repository, and what happens to tasks no routing rule matches. Hover or focus a source or repository to trace its routes.
- **Repositories, automations, estimations, and error monitors.**
- **Credentials.** Which env files each scope loads and which keys they define. Values are never shown.
- **Policy.** Concurrency, task pickup, pull request, and maintenance settings.

The page also tells you whether the running worker has applied the latest version of the file. A save that changes a setting that needs a restart (the default tracker, a team's name, tracker, or env, error monitors, the dashboard port, or the working-hours schedule) is rejected as a whole, so nothing else in that save applies either; the page shows the rejection reason. Workers that predate this check cannot report it, and the page says so.

## Retry a failed run

Open the failed run and choose **Retry**. The worker queues a fresh attempt using the same task and workspace routing rules.

Retry after correcting the underlying problem, for example missing credentials, unclear task details, or a temporary agent failure. The dashboard prevents duplicate retries while another attempt is already queued or running.

Ad-hoc tasks created with `devintern worker add` show **Re-queue task** instead: the queue row is put back as `pending` under its existing key, so the worker resumes the interrupted attempt's branch and report rather than opening a second branch and pull request. The worker also auto-resumes an interrupted ad-hoc task once at startup when its prior local run recorded a resumable branch with either an implementation report or commits ahead of the repo's base (unless the interrupted attempt's child process is still alive; the row then stays `running` and is re-checked at the next startup, and re-queueing is refused with the pid to stop first); **Re-queue task** remains available for rows that were not resumable or whose automatic-resume budget is exhausted. If the row was already pruned (30 days by default) or is still queued/running, the run detail explains why it cannot be re-queued and points at `devintern worker add`.

## Run an automation now

Open **Automations**, find the automation, and choose **Run now**. When automations target more than one repository, the list groups them: automations without a `repo` come first under **General**, then one group per repository in name order, with enabled automations ahead of disabled ones and the soonest next run first. The worker runs it through the same pipeline as a scheduled occurrence, including its normal repository, environment, and overlap protection.

Open an automation from the list to read its full prompt, see its schedule and next run, and review its recent runs.

This is useful for testing a new automation prompt or running routine work early.

## Delegate a task

Choose **New task** in the header to open a dialog that hands the worker a one-off task, the dashboard equivalent of [`devintern worker add`](delegation.md). Pick a registered `[[repos]]` repository (preselected when the workspace has only one), give the task a title, and describe the work in Markdown. The description is limited to 20,000 characters, and a counter shows how much is left. The worker sees only this text, so keep the brief self-contained; see [Write a self-contained brief](delegation.md#write-a-self-contained-brief). Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (<kbd>⌘</kbd>+<kbd>Enter</kbd> on macOS) in the description to enqueue; <kbd>Enter</kbd> in the title does not submit.

The task is queued in the workspace and the running worker picks it up on its next poll. The dashboard never starts a worker for you: with no worker running, the task waits in the queue until one starts. Like every ad-hoc task, it bypasses [working windows](worker.md#working-windows-quiet-hours) and inherits `[defaults].worker_task_args` (default `--create-pr`), so the worker can start right away and open a pull request.

After you submit, the dialog shows the task key (`local-<slug>`) and status, links to **Runs**, and adds **Open run** as soon as the worker records the run. Each time you open the dialog it uses its own idempotency key, so a double-click or a retry after a network error returns the task that is already queued (shown as **Already queued**) instead of creating a duplicate. **Create another task**, or reopening the dialog, starts a fresh draft with a new key.

The dialog protects unsent drafts: once a title or description is typed, clicking outside does nothing, and <kbd>Esc</kbd>, **Cancel**, or closing asks before discarding it. While a task is being submitted, the fields are locked and the dialog cannot be closed.

**New task** needs a workspace with at least one registered repository. A dashboard without one, for example a standalone `devintern dashboard` on a legacy single-project setup, explains that and points at `devintern worker add-repo`.

For scripts, prefer [`devintern worker add`](delegation.md): it needs no running dashboard and can wait for the result. To call the endpoint directly, send JSON with an `Origin` that matches the address you call. Browsers add `Origin` automatically, but curl does not, and the dashboard refuses writes without it (see [Local by design](#local-by-design)):

```bash
curl -s http://127.0.0.1:4400/api/tasks \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:4400' \
  -d '{"repo":"backend","title":"Bump the lockfile","body":"","idempotencyKey":"lockfile-1"}'
```

The response has the same shape as `devintern worker add --json`: `{ id, taskKey, repo, status, deduplicated }`, with HTTP 201 for a new task and 200 when an active task with the same idempotency key was reused. An unknown repository, an empty title, or an oversized body returns 400 with an `error` message; a dashboard without a usable workspace returns 409. A missing or mismatched `Origin` returns 403, and a non-JSON body returns 415.

## View the dashboard without the worker

You can inspect existing run history even when the worker is stopped:

```bash
devintern dashboard
```

The command reads the local history without changing it; only explicit actions such as **Retry** and **New task** write to the queue. Use `--port <number>` if port 4400 is already occupied (or set `DASHBOARD_PORT`), and `--host <host>` to bind a different loopback address (default `127.0.0.1`; `localhost` and `::1` are also accepted). `--allow-origin <origin>` (repeatable) and `--no-tailscale-autodetect` control [allowed origins](#allowed-origins).

Run history (runs, stats, agent PRs, artifacts, retry audit) comes from the same project-scoped `.devintern-code/queue.db` that a direct `devintern <TASK>` run writes, so local runs stay visible when a workspace is also configured. The pending ad-hoc and scheduled-retry counts in the header come from the workspace queue database (`~/.devintern/state/queue.db`). If you started the worker with a custom `--workspace /path/to/workspace.toml`, pass the same flag to the dashboard so queue counts, worker liveness, and harness-log transcripts follow it. The value can be the `workspace.toml` file or the directory that contains it:

```bash
devintern dashboard --workspace /path/to/workspace.toml
```

With `--workspace`, the dashboard also applies that workspace's [`[dashboard]` access settings](#allowed-origins), and **Automations** lists that workspace's `[[automations]]` with their next scheduled run. **Run now** needs the worker, because workspace automations run through its routing and repository pipeline; start `devintern worker` and use its dashboard to trigger them.

## Local by design

The dashboard and its data stay on the worker machine. It listens only on a loopback address, so it is not exposed to your network or the public internet. There is no setting that binds it to another address: a non-loopback bind fails before the server starts, because the dashboard has no built-in authentication and its write endpoints retry runs, trigger automations, and enqueue tasks.

The API also refuses requests that did not come from the dashboard page itself, so a website open in your browser cannot use it behind your back:

- Every `/api` request must be addressed to `localhost`, `127.0.0.1`, or `[::1]` (any port, so remapped SSH tunnels work), or to an [allowed origin](#allowed-origins). Any other host name gets `403`. This blocks DNS-rebinding attacks, where a hostile domain is pointed at your loopback address.
- Requests that change something (retry, run now, new task, and any other non-GET action) must come from the same origin as the address they were sent to, for example `Origin: http://localhost:8440` for `localhost:8440`, and must send `Content-Type: application/json`. Cross-origin requests get `403`; other content types get `415`. A page served on another local port cannot read the API or act on it.

Worker run history lives in the worker's workspace, alongside its other local state. The embedded dashboard remains available when an expired Worker Pilot pauses acquisition. Starting a standalone dashboard requires an active Worker Pilot or automation license.

To disable the dashboard or change its port, edit the workspace settings:

```toml
[workspace]
dashboard = false
# dashboard_port = 4400
```

## Access the dashboard from another device

Watching a long run from your laptop or phone does not require opening the dashboard port. Put an authenticating boundary in front of the loopback listener instead — your SSH client, your Tailscale tailnet, or a reverse proxy with its own login. All three options below leave the dashboard bound to `127.0.0.1`, and they work the same for the worker-embedded dashboard and for `devintern dashboard`.

**Treat the dashboard as sensitive.** Run transcripts, logs, and artifacts can contain credentials or customer data, and `POST /api/runs/:id/retry`, `POST /api/automations/:id/run`, and `POST /api/tasks` act with your repository credentials. That is why the recipes below add a login rather than just moving the bind address.

### Option 1: SSH tunnel

The smallest setup, and the right default when you only need access from another computer.

```bash
ssh -N -L 4400:127.0.0.1:4400 you@worker-host
```

Open [http://localhost:4400](http://localhost:4400) on your own machine and the traffic is forwarded over the SSH connection. Add `-f` to background the tunnel, or configure a `LocalForward 4400 127.0.0.1:4400` entry in `~/.ssh/config` to make it permanent. Mobile SSH clients such as Termius and Blink support local port forwarding too.

If port 4400 is busy locally, forward a different local port: `-L 8440:127.0.0.1:4400` and open `http://localhost:8440`. Loopback addresses are trusted on any port, so this needs no extra configuration.

### Option 2: Tailscale Serve

Best for phone and multi-device access. The dashboard becomes a private HTTPS origin on your tailnet, and no other device on the network can reach it.

```bash
tailscale serve --bg 4400
```

Tailscale terminates TLS and forwards to `http://127.0.0.1:4400`, so open the `https://<machine>.<tailnet>.ts.net/` URL the command prints. Only devices in your tailnet can connect, and Tailscale's device identity is the access boundary.

This works without dashboard configuration. At startup, and again when a request arrives for an unknown host name (at most every 30 seconds), the dashboard runs `tailscale serve status --json` and trusts each `https://<name>` whose handler proxies to its own port. The startup log lists the detected origins. A `tailscale serve` set up after the dashboard started is picked up on the next request. If the `tailscale` binary is missing or fails, detection is skipped. To turn detection off, set `[dashboard].tailscale_autodetect = false`, `DASHBOARD_TAILSCALE_AUTODETECT=0`, or pass `devintern dashboard --no-tailscale-autodetect`. If detection does not find your setup, list the origin explicitly:

```toml
[dashboard]
allowed_origins = ["https://box.tailnet.ts.net"]
```

Use [Tailscale ACLs](https://tailscale.com/kb/1018/acls) to control which tailnet devices and users can reach the machine.

Do not use `tailscale funnel` for the dashboard. Funnel publishes the port on the public internet with no login prompt in front of it. If the dashboard detects a Funnel-published name, it still trusts it but logs a prominent warning at startup.

### Option 3: Reverse proxy with its own login

Use this when the dashboard needs to live at a fixed address on your internal network, for example behind an existing ingress or company SSO proxy. Keep the dashboard on loopback and let the proxy own the network-facing listener:

```caddyfile
http://192.168.1.50:8088 {
	basic_auth {
		you $2a$14$REPLACE_WITH_OUTPUT_OF_CADDY_HASH_PASSWORD
	}
	reverse_proxy 127.0.0.1:4400
}
```

Then allow the proxy's origin, because the browser addresses the dashboard as `192.168.1.50:8088`:

```toml
[dashboard]
allowed_origins = ["http://192.168.1.50:8088"]
```

Generate the hash with `caddy hash-password`, then reload Caddy and restart the worker. Caddy forwards the original `Host`, which now matches the allowed origin; proxies that rewrite `Host` to `127.0.0.1:4400` (nginx's default) also work, because a write from an allowed origin is accepted on a loopback host. Anything the proxy authenticates is forwarded to loopback, so the dashboard itself still refuses to listen on the LAN address.

Plain HTTP means the password and the dashboard data cross your network unencrypted. Do this only on a trusted internal network, and prefer Options 1 and 2 elsewhere. Add `tls internal` and use an `https://` site address if you want Caddy-managed certificates for a private hostname.

Whichever proxy you choose, it must authenticate every request itself; do not run an unauthenticated forwarder, and do not add a second listener that reaches the dashboard without a credential check.

### Allowed origins

An allowed origin is a full `scheme://host[:port]` the dashboard trusts in addition to loopback. Requests whose `Host` is that host and port are accepted, and writes from that exact `Origin` are accepted. Matching is exact: no wildcards. Case, default ports (`:443` for https, `:80` for http), and a trailing slash are normalized, and entries with a path, query, or `user@` are rejected. `X-Forwarded-*` headers are never consulted. The list is merged from three places:

| Source | Example |
| --- | --- |
| `workspace.toml` (worker and `devintern dashboard --workspace`) | `[dashboard]` `allowed_origins = ["https://dash.example.internal"]` |
| Environment variable (comma-separated) | `DASHBOARD_ALLOWED_ORIGINS=https://dash.example.internal,http://192.168.1.50:8088` |
| `devintern dashboard` flag (repeatable) | `--allow-origin https://dash.example.internal` |

A malformed entry stops the worker or dashboard at startup with an error naming it. `[dashboard]` is startup-only: restart the worker after changing it. When the list is not empty, the startup log prints it with a warning that anyone who can reach those addresses gets full dashboard access, including write actions.

Allowed origins stop other websites from using your browser against the dashboard. They do not authenticate anyone. Who can reach the address is still decided by your Tailscale ACLs or by the proxy's login (for example Caddy `basic_auth`).

## Artifacts

Run detail shows registered outputs with producing step, execution, commit, and
capture time. Preview text/Markdown and raster images, or download complete
files. Each attempt retains its own snapshots; unavailable files remain listed.
See [Pipeline artifacts](./artifacts.md) for capture and PR-comment publication.
