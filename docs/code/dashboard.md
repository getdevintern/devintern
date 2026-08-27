---
title: "Observability Dashboard"
description: "A local web dashboard for worker run history: per-task timelines, stage-by-stage outcomes, aggregate stats, and run retries"
section: "Server Automation"
order: 2
dateModified: 2026-08-27
---

# Observability Dashboard

`devintern dashboard` serves a local web dashboard over the worker's run history: every task, PR mention, and scheduled automation the worker handled, the stages each run went through (feasibility, implementation, self-review, change requests, outcome), aggregate stats like success rate and runs per week, and a retry action for failed runs.

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

- **Run list**: every run with its status, task key or automation id, origin (tracker task, PR mention, or scheduled), agent harness, PR link, and duration. Filter by status or origin (`origin=scheduled` isolates automation runs).
- **Run detail**: a stage-by-stage timeline for one run: the feasibility verdict, the implementation summary, each self-review iteration, each human change request and how it was handled, and the final outcome.
- **Stats**: runs per week, success and escalation rates, median run duration, and a per-harness breakdown over a selectable window (7, 30, or 90 days, or all time).
- **Worker status**: whether the daemon is running, queued and failed events, open agent PRs, and per-source poll cursors.

Success and escalation rates are computed over finished runs only. Run duration is measured from pickup to PR creation and is a proxy for ticket-to-PR time. Merge rate is not shown yet: the worker records PRs as open or closed but does not track merges separately.

## Retrying a run

Failed, escalated, and abandoned runs (and only those — succeeded runs have nothing to redo, deferred runs retry on their own schedule, and in-progress runs are still going) show a **Retry this run** action on the run detail page. Confirming it runs the same flow a support engineer would run by hand:

```bash
devintern PROJ-123 --force
```

The dashboard server spawns that command as its own subprocess, so branch selection, worktree handling, comments, and `--force`'s bypass of the incomplete-attempt retry gate behave exactly like the CLI. Because the full pipeline runs in that subprocess, the new attempt appears as a fresh run in the run list within moments of triggering; the dashboard shows success/failure feedback for the trigger itself plus the new run's progress through its stages.

Safeguards:

- A confirmation prompt states exactly what will be re-run before anything starts.
- The actor must be signed in (`devintern login`); when `DASHBOARD_RETRY_EMAILS` is set, only those support-role email addresses may trigger retries.
- Retries are serialized per task: while a just-triggered retry is starting or another attempt is still in progress (including one recorded by the worker), further triggers are refused.
- Every trigger is audited in `.devintern-code/queue.db` (`run_retry_audit`): who retried, when, with which command and pid, and against which original run. The run detail page lists this history under "Retry history".

### Environment variables

| Variable                  | Description                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `DASHBOARD_PORT`          | Port to listen on when `--port` is not given                                                     |
| `DASHBOARD_RETRY_EMAILS`  | Comma-separated allowlist of emails authorized to trigger retries; unset means any signed-in user |

## Options

| Option          | Description                                           |
| --------------- | ----------------------------------------------------- |
| `--port <port>` | Port to listen on (default: 4400 or `DASHBOARD_PORT`) |
| `--host <host>` | Host to bind to (default: 127.0.0.1)                  |

The dashboard has no authentication. It binds to localhost by default; binding to another host means anyone who can reach that address can read your run history, so keep it on your own machine or behind something that handles access for you.

With `devintern worker`, set `[workspace].dashboard = false` to disable the embedded dashboard or `[workspace].dashboard_port` to change its port. A dashboard startup failure is reported but does not stop task processing.

## JSON API

The dashboard is backed by a small read-only JSON API you can use directly, for example from scripts:

| Endpoint                        | Returns                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `GET /api/runs`                 | Paginated run list (`limit`, `offset`, `status`, `origin`, `taskKey`); `origin=scheduled` is supported |
| `GET /api/runs/:id`             | One run with its stage timeline and retry metadata                    |
| `POST /api/runs/:id/retry`      | Re-run the task behind a failed/escalated/abandoned run (`--force` flow; requires sign-in) |
| `GET /api/stats?window=30d`     | Aggregate stats (`7d`, `30d`, `90d`, or `all`)                        |
| `GET /api/worker`               | Worker liveness, queue counts, agent PRs, poll cursors                |
| `GET /api/health`               | Health check                                                          |

## License

The dashboard is part of the automation tier and requires an automation license (solo supporter, team subscription, or legacy server addon) or an active trial, the same requirement the worker has.
