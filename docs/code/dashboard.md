---
title: "Observability Dashboard"
description: "A local web dashboard for worker run history: per-task timelines, stage-by-stage outcomes, and aggregate stats"
section: "Server Automation"
order: 2
dateModified: 2026-08-27
---

# Observability Dashboard

`devintern dashboard` serves a local web dashboard over the worker's run history: every task, PR mention, and scheduled automation the worker handled, the stages each run went through (feasibility, implementation, self-review, change requests, outcome), and aggregate stats like success rate and runs per week.

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
- **Worker status**: whether the daemon is running, queued and failed events, open agent PRs, and per-source poll cursors.

Success and escalation rates are computed over finished runs only. Run duration is measured from pickup to PR creation and is a proxy for ticket-to-PR time. Merge rate is not shown yet: the worker records PRs as open or closed but does not track merges separately.

The ticket link and description snapshot work for remote trackers whose web URLs can be derived from base configuration plus the task key (Jira, GitHub Issues, GitLab, Azure DevOps, Asana, Trello). Linear issue links need the organization slug, so those keys stay plain text there; markdown-file runs (including scheduled automations) have no tracker page at all. Descriptions are persisted when the run begins, so history keeps showing what was asked even if the ticket is later edited or deleted.

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
| `GET /api/health`           | Health check                                                          |

## License

The dashboard is part of the automation tier and requires an automation license (solo supporter, team subscription, or legacy server addon) or an active trial, the same requirement the worker has.
