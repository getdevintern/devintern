---
title: "Observability Dashboard"
description: "A local web dashboard for worker run history: per-task timelines, stage-by-stage outcomes, and aggregate stats"
section: "Server Automation"
order: 2
dateModified: 2026-07-03
---

# Observability Dashboard

`devintern dashboard` serves a local web dashboard over the worker's run history: every task and PR mention the worker handled, the stages each run went through (feasibility, implementation, self-review, change requests, outcome), and aggregate stats like success rate and runs per week.

All data is read from the worker's local database (`.devintern-code/queue.db`). Nothing is uploaded anywhere: the dashboard runs on your machine and binds to localhost by default.

## Quick Start

```bash
# Standalone: works whether or not the worker is running
devintern dashboard

# Or serve it alongside the worker daemon
devintern worker --query "status=todo" --ui
```

Then open http://localhost:4400.

The standalone command reads the database in read-only mode, so it is safe to run next to a live worker, and it still works after the worker is stopped (for example to review last week's runs).

## What it shows

- **Run list**: every run with its status, task key, origin (tracker task or PR mention), agent harness, PR link, duration, and known cost. Filter by status or origin.
- **Run detail**: a stage-by-stage timeline for one run: the feasibility verdict, the implementation summary, each self-review iteration, each human change request and how it was handled, and the final outcome. Runs that reported token usage also show the model, token totals (input / output), and cost (only when the harness reported one).
- **Stats**: runs per week, success and escalation rates, median run duration, aggregate token usage and known spend, and a per-harness breakdown (including per-harness spend) over a selectable window (7, 30, or 90 days, or all time).
- **Worker status**: whether the daemon is running, queued and failed events, open agent PRs, and per-source poll cursors.

Success and escalation rates are computed over finished runs only. Run duration is measured from pickup to PR creation and is a proxy for ticket-to-PR time. Merge rate is not shown yet: the worker records PRs as open or closed but does not track merges separately.

### Usage and cost data quality

Token/cost accounting depends on what each harness CLI reports: usage is captured only from structured JSON output (e.g. `--json` / `--output-format json` modes), and CLIs that don't emit it show no usage at all rather than zeros. Wherever data is partial, the dashboard says so explicitly — unknown costs render as "unknown" (never `$0.00`) and incomplete accounting is marked "(partial)". Aggregate stats sum only *known* values and show an explicit partial-data notice when runs in the window have missing or unpriced usage.

## Options

| Option          | Description                                           |
| --------------- | ----------------------------------------------------- |
| `--port <port>` | Port to listen on (default: 4400 or `DASHBOARD_PORT`) |
| `--host <host>` | Host to bind to (default: 127.0.0.1)                  |

The dashboard has no authentication. It binds to localhost by default; binding to another host means anyone who can reach that address can read your run history, so keep it on your own machine or behind something that handles access for you.

With `devintern worker --ui`, use `--ui-port` to change the dashboard port (the worker's own `--port` belongs to the webhook listener).

## JSON API

The dashboard is backed by a small read-only JSON API you can use directly, for example from scripts:

| Endpoint                    | Returns                                                               |
| --------------------------- | --------------------------------------------------------------------- |
| `GET /api/runs`             | Paginated run list (`limit`, `offset`, `status`, `origin`, `taskKey`) |
| `GET /api/runs/:id`         | One run with its stage timeline                                       |
| `GET /api/stats?window=30d` | Aggregate stats (`7d`, `30d`, `90d`, or `all`)                        |
| `GET /api/worker`           | Worker liveness, queue counts, agent PRs, poll cursors                |
| `GET /api/health`           | Health check                                                          |

## License

The dashboard is part of the automation tier and requires an automation license (solo supporter, team subscription, or legacy server addon) or an active trial, the same requirement the worker has.
