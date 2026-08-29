---
title: "Observability Dashboard"
description: "A local web dashboard for worker run history: per-task timelines, stage-by-stage outcomes, aggregate stats, and worker logs"
section: "Server Automation"
order: 2
dateModified: 2026-08-27
---

# Observability Dashboard

`devintern dashboard` serves a local web dashboard over the worker's run history: every task, PR mention, and scheduled automation the worker handled, the stages each run went through (feasibility, implementation, self-review, change requests, outcome), aggregate stats like success rate and runs per week, and the worker's own log output.

All data is read from the worker's local database (`.devintern-code/queue.db`). Nothing is uploaded anywhere: the dashboard runs on your machine and binds to localhost by default.

## Quick Start

```bash
# Standalone: works whether or not the worker is running
devintern dashboard

# Or serve it alongside the worker daemon
devintern worker # dashboard starts alongside the worker by default
```

Then open http://localhost:4400.

The standalone command reads the database in read-only mode, so it is safe to run next to a live worker, and it still works after the worker is stopped (for example to review last week's runs).

## What it shows

- **Run list**: every run with its status, task key or automation id, origin (tracker task, PR mention, or scheduled), agent harness, PR link, and duration. The task key links straight to the tracker ticket when the tracker's URL can be derived from your configuration; filter by status or origin (`origin=scheduled` isolates automation runs).
- **Run detail**: the task key header (linked to its tracker ticket when possible) plus a snapshot of the original task description — captured when the run started and rendered as markdown — followed by a stage-by-stage timeline: the feasibility verdict, the implementation summary, each self-review iteration, each human change request and how it was handled, and the final outcome.
- **Stats**: runs per week, success and escalation rates, median run duration, and a per-harness breakdown over a selectable window (7, 30, or 90 days, or all time).
- **Logs**: the most recent worker log lines (timestamp, severity, message), filterable by level (`everything` / `warnings` / `errors`) with a search box over the loaded window. Lines that mention a task key link straight to that task's latest run in the Runs view.
- **Worker status**: whether the daemon is running, queued and failed events, open agent PRs, and per-source poll cursors.

Success and escalation rates are computed over finished runs only. Run duration is measured from pickup to PR creation and is a proxy for ticket-to-PR time. Merge rate is not shown yet: the worker records PRs as open or closed but does not track merges separately.

The ticket link and description snapshot work for remote trackers whose web URLs can be derived from base configuration plus the task key (Jira, GitHub Issues, GitLab, Azure DevOps, Asana, Trello). Linear issue links need the organization slug, so those keys stay plain text there; markdown-file runs (including scheduled automations) have no tracker page at all. Descriptions are persisted when the run begins, so history keeps showing what was asked even if the ticket is later edited or deleted.

## Where the logs come from

The worker daemon tees its own console output into `worker.stdout.log` and `worker.stderr.log` in the workspace home (`~/.devintern`), so the Logs tab works no matter how the daemon is launched — a systemd unit, launchd agent, cron wrapper, or a plain terminal — without the service definition having to redirect stdout/stderr. Each file rotates to `<name>.1` past 8 MiB. The Logs tab tails those capture files — whether or not the worker is currently running — and only reads a bounded tail (the most recent ~256 KiB per file, at most 500 lines), so huge logs never slow down or bloat the dashboard.

To follow the same output in a terminal:

```bash
tail -f ~/.devintern/worker.stdout.log ~/.devintern/worker.stderr.log
```

If `DEVINTERN_WORKSPACE_DIR` is set, the capture files live in that directory instead. When the files stay empty, your service definition still redirects output elsewhere — for example a `>> file` shell wrapper in the unit. Remove the redirect (or re-run `worker init` and reinstall the unit), or fall back to the journal: `journalctl --user -u devintern-worker -f`.

A few behaviors worth knowing:

- **No timestamps?** Capture files written by a service redirect instead of the worker's own capture have no timestamps; those entries show `–` for time and keep their relative order. The worker's own capture timestamps every line.
- **Secrets**: log lines are scanned for credential-shaped content (`TOKEN=…` style assignments, common token formats) and masked before being served. Logs stay on this machine either way.
- **ANSI codes**: terminal colors and control characters are stripped for clean rendering.
- **If nothing shows up**: when no capture file exists (fresh install, or the worker has only ever run in the foreground), the tab explains where logs would be instead of showing an error.

## Options

| Option          | Description                                           |
| --------------- | ----------------------------------------------------- |
| `--port <port>` | Port to listen on (default: 4400 or `DASHBOARD_PORT`) |
| `--host <host>` | Host to bind to (default: 127.0.0.1)                  |

The dashboard has no authentication. It binds to localhost by default; binding to another host means anyone who can reach that address can read your run history, so keep it on your own machine or behind something that handles access for you.

With `devintern worker`, set `[workspace].dashboard = false` to disable the embedded dashboard or `[workspace].dashboard_port` to change its port. A dashboard startup failure is reported but does not stop task processing.

## JSON API

The dashboard is backed by a small read-only JSON API you can use directly, for example from scripts:

| Endpoint                    | Returns                                                               |
| --------------------------- | --------------------------------------------------------------------- |
| `GET /api/runs`             | Paginated run list (`limit`, `offset`, `status`, `origin`, `taskKey`); `origin=scheduled` is supported |
| `GET /api/runs/:id`         | One run with its stage timeline                                       |
| `GET /api/stats?window=30d` | Aggregate stats (`7d`, `30d`, `90d`, or `all`)                        |
| `GET /api/worker`           | Worker liveness, queue counts, agent PRs, poll cursors                |
| `GET /api/logs`             | Recent worker log entries (`limit` 1–1000, default 500; `level` all/info/warn/error) |
| `GET /api/health`           | Health check                                                          |

## License

The dashboard is part of the automation tier and requires an automation license (solo supporter, team subscription, or legacy server addon) or an active trial, the same requirement the worker has.
