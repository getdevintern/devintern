---
title: "Observability Dashboard"
description: "A local web dashboard for worker run history: per-task timelines, stage-by-stage outcomes, aggregate stats, run-now automation triggers, run retries, and worker logs"
section: "Server Automation"
order: 2
dateModified: 2026-09-01
---

# Observability Dashboard

`devintern dashboard` serves a local web dashboard over the worker's run history: every task, PR mention, and scheduled automation the worker handled, the stages each run went through (feasibility, implementation, self-review, change requests, outcome), aggregate stats like success rate and runs per week, run-now triggers for scheduled automations, a retry action for failed runs, and the worker's own log output.

All data is read from the worker's local database (`.devintern-code/queue.db`). Nothing is uploaded anywhere: the dashboard runs on your machine and is restricted to a loopback address.

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

- **Run list**: every run with its status, task key or automation id, origin (tracker task, PR mention, scheduled, estimate, or manual), agent harness, git branch, PR link, and duration. The task key links straight to the tracker ticket when the tracker's URL can be derived from your configuration; filter by status or origin (`origin=scheduled` isolates scheduled automation runs, `origin=manual` isolates runs you triggered yourself with "Run now", and `origin=estimate` isolates story-point sweeps). The harness and branch are recorded when the run starts, so runs from before they were recorded show `–`.
- **Automations**: every scheduled automation configured in `workspace.toml` (`[[automations]]`) — or `.devintern-code/automations.toml` for a standalone dashboard — with its schedule, target repo, the next scheduled occurrence, and the most recent run (click it to open the run detail). Each enabled automation has a **Run now** action; see [Running an automation now](#running-an-automation-now).
- **Run detail**: the task key header (linked to its tracker ticket when possible) plus a snapshot of the original task description — captured when the run started and rendered as markdown — followed by a stage-by-stage timeline: the feasibility verdict, the implementation summary, each self-review iteration, each human change request and how it was handled, and the final outcome.
- **Agent PRs**: every pull request the worker created that is still open — repo, PR number, branch, linked ticket key, and age — with a direct link to each PR on GitHub. The worker reconciles this list with GitHub on every poll cycle, so PRs merged or closed outside the worker drop out automatically.
- **Stats**: runs per week, success and escalation rates, median run duration, and a per-harness breakdown over a selectable window (7, 30, or 90 days, or all time).
- **Logs**: the most recent worker log lines (timestamp, severity, message), filterable by level (`everything` / `warnings` / `errors`) with a search box over the loaded window. Lines that mention a task key link straight to that task's latest run in the Runs view.
- **Worker status**: whether the daemon is running, queued and failed events, the open agent PR count (linked to the Agent PRs view), and per-source poll cursors.

Worker liveness is read from the daemon's lock file, in the project's `.devintern-code/` directory and in the workspace home (`~/.devintern`), so the header is accurate whether the worker runs in the foreground or as a launchd/systemd service. When no lock file is found in either location, the header says "worker status unknown" instead of "stopped" — the dashboard may simply be pointed at a different directory than the worker.

Success and escalation rates are computed over finished runs only. Run duration is measured from pickup to PR creation and is a proxy for ticket-to-PR time. Merge rate is not shown yet: the worker records PRs as open or closed but does not track merges separately.

The ticket link and description snapshot work for remote trackers whose web URLs can be derived from base configuration plus the task key (Jira, GitHub Issues, GitLab, Azure DevOps, Asana, Trello). Linear issue links need the organization slug, so those keys stay plain text there; markdown-file runs (including scheduled automations) have no tracker page at all. Descriptions are persisted when the run begins, so history keeps showing what was asked even if the ticket is later edited or deleted.

## Retrying a run

Failed, escalated, and abandoned runs (and only those — succeeded runs have nothing to redo, deferred runs retry on their own schedule, and in-progress runs are still going) show a **Retry this run** action on the run detail page. Confirming it schedules the same flow a support engineer would run by hand:

```bash
devintern PROJ-123 --force
```

How the retry executes depends on where the dashboard runs:

- **Workspace worker (fleet mode)** — the default dashboard served by `devintern worker` inserts the retry into the shared workspace database, and the worker's retry-queue acquirer picks it up (default every 5 seconds, tunable with `WORKER_RETRY_INTERVAL_SECONDS`). The retry then runs through exactly the same pipeline as any fleet task: routing rules pick the repo, the task gets a disposable worktree from the bare clone, the per-repo environment applies, and the repo run lock serializes concurrent work. `--force` bypasses the incomplete-attempt retry gate, like the manual CLI flow.
- **Standalone `devintern dashboard`** — when the dashboard runs by itself inside a repo checkout, it spawns `devintern <TASK> --force` as its own subprocess instead, mirroring the manual CLI flow; branch selection, worktree handling, and comments behave exactly like the CLI.

In both modes the new attempt appears as a fresh run in the run list; the dashboard shows success/failure feedback for the trigger itself plus the new run's progress through its stages.

Safeguards:

- A confirmation prompt states exactly what will be re-run before anything starts.
- The dashboard is reachable only over loopback; remote binds are refused.
- Retries are serialized per task: while a retry is already scheduled or running (including an attempt recorded by the worker), further triggers are refused.
- Every trigger is audited in `.devintern-code/queue.db` (`run_retry_audit`) as `local-dashboard`, with its timestamp and original run target. The run detail page lists this history under "Retry history".

### Environment variables

| Variable                        | Description                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `DASHBOARD_PORT`                | Port to listen on when `--port` is not given                                             |
| `WORKER_RETRY_INTERVAL_SECONDS` | How often the workspace worker drains scheduled dashboard retries (default 5, minimum 1) |

## Running an automation now

The **Automations** tab lists every configured scheduled automation with its schedule, repo, next occurrence, and last run. Each enabled automation has a **Run now** action that executes it immediately, so you can validate a new or edited configuration in seconds instead of waiting for the next schedule window.

A manual run is not a simulation: it goes through exactly the same pipeline as a scheduled run — the prompt is materialized as an occurrence task file and processed like any other task (clarity check, planning, implementation, estimation outputs, commit, PR creation, review) — so what you see is precisely what the schedule would produce. The run is recorded in run history with origin `manual` (instead of `scheduled`) and the automation's id, so you can always tell manual validation runs apart from scheduled ones.

How the trigger executes depends on where the dashboard runs:

- **Workspace worker (fleet mode)** — the default dashboard served by `devintern worker` hands the trigger to the worker's in-process automation scheduler, so a manual run shares the scheduled machinery: the repo's base worktree, the per-repo environment, the run coordinator, and the automation's overlap lease.
- **Standalone `devintern dashboard`** — a dashboard running by itself inside a repo checkout lists that repo's `.devintern-code/automations.toml` and spawns the regular CLI on the materialized occurrence file — the same flow as running `devintern ~/.devintern/automations/<id>/<stamp>.md` by hand. Workspace `[[automations]]` entries are not listed here: their fleet pipeline (routing, bare clones, base worktrees) only exists in the worker process, so trigger those from the worker's embedded dashboard.

Feedback and safeguards:

- The button shows progress while the run starts and reports success (with a pointer to the run list) or the exact refusal reason when it completes. The run itself then reports its stages like any other run.
- The action is available only through the loopback-bound dashboard.
- Disabled automations show no run action and are refused with an explanation if triggered via the API.
- A run already in progress (scheduled or manual) blocks further triggers until it finishes, and a second rapid trigger is debounced while the first is still starting.
- Overlap follows the scheduler's at-most-once policy: while a manual run is active, a scheduled occurrence coming due is skipped (logged), never run concurrently.

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

| Option          | Description                                                                      |
| --------------- | -------------------------------------------------------------------------------- |
| `--port <port>` | Port to listen on (default: 4400 or `DASHBOARD_PORT`)                            |
| `--host <host>` | Loopback host to bind to (default: 127.0.0.1; also accepts `localhost` or `::1`) |

The dashboard currently uses loopback access as its security boundary. Both standalone dashboard mode and the dashboard embedded in `devintern worker` reject non-loopback hosts; remote access is not supported until request-level authentication is implemented.

With `devintern worker`, set `[workspace].dashboard = false` to disable the embedded dashboard or `[workspace].dashboard_port` to change its port. A dashboard startup failure is reported but does not stop task processing.

## JSON API

The dashboard is backed by a small local JSON API you can use directly, for example from scripts:

| Endpoint                        | Returns                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/runs`                 | Paginated run list (`limit`, `offset`, `status`, `origin`, `taskKey`); `origin=scheduled`, `origin=manual`, and `origin=estimate` are supported |
| `GET /api/runs/:id`             | One run with its stage timeline and retry metadata                                                                                              |
| `GET /api/automations`          | Configured scheduled automations with schedule state and last run                                                                               |
| `POST /api/automations/:id/run` | Trigger a manual run of a scheduled automation                                                                                                  |
| `GET /api/agent-prs`            | Open agent-created PRs with GitHub links, branches, and ticket keys                                                                             |
| `POST /api/runs/:id/retry`      | Schedule a re-run of the task behind a failed/escalated/abandoned run                                                                           |
| `GET /api/stats?window=30d`     | Aggregate stats (`7d`, `30d`, `90d`, or `all`)                                                                                                  |
| `GET /api/worker`               | Worker liveness (`running`, `stopped`, or `unknown`), queue counts, agent PR counts, poll cursors                                               |
| `GET /api/logs`                 | Recent worker log entries (`limit` 1–1000, default 500; `level` all/info/warn/error)                                                            |
| `GET /api/health`               | Health check                                                                                                                                    |

## License

The dashboard is part of the automation tier and requires an automation license (solo supporter, team subscription, or legacy server addon) or an active trial, the same requirement the worker has.
