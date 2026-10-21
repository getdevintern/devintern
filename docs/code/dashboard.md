---
title: "Worker Dashboard"
sidebarLabel: "Dashboard"
description: "See what the worker is doing, inspect failed runs, and retry work from a local dashboard"
section: "Automation"
order: 4
dateModified: 2026-10-21
---

# Worker Dashboard

The dashboard answers a simple question: **what has the worker been doing?** It gives you a local view of current and past runs without making you read terminal output or inspect the worker database.

It starts automatically with `devintern worker`. Open [http://localhost:4400](http://localhost:4400) on the machine running the worker.

## What you can do

- See whether the worker is running, waiting for its next working window, or processing a task
- Follow each run from task pickup through implementation and pull request creation
- Read the raw agent transcript for any harness execution under the run (clarity, implementation, review, and more)
- Open the task or pull request behind a run
- Understand why a run failed and retry it after fixing the cause
- Run a recurring automation immediately instead of waiting for its next scheduled time
- Review recent worker logs when something needs attention

The overview also summarizes activity and success rates, which is useful for spotting repeated failures without checking every run individually.

## Follow task activity

Open **Task activity** to see the step board. It includes all in-progress runs and the latest 100 runs, grouped by their explicitly recorded current or last step. Search by task, repository, branch, agent, or step, and filter by status. Select a card to see its activity and outcome, then choose **Show run details** for transcripts, artifacts, completed stages, and retry actions.

Step tracking follows the task pipeline, including preparation, feasibility, implementation, commit, auto-review, publication, and custom steps. Repeated steps update their start time. Status badges distinguish running work from succeeded, failed, deferred, escalated, or abandoned runs; terminal runs retain their last recorded step without claiming it is still running. Between steps, the board identifies the last step explicitly.

Older runs and workflows that do not use the task step runner appear under **Step unavailable**. The board never guesses the current step from a completed stage. A run interrupted before recovery may still be recorded as in progress until the worker reconciles its history.

## Retry a failed run

Open the failed run and choose **Retry**. The worker queues a fresh attempt using the same task and workspace routing rules.

Retry after correcting the underlying problem, for example missing credentials, unclear task details, or a temporary agent failure. The dashboard prevents duplicate retries while another attempt is already queued or running.

Ad-hoc tasks created with `devintern worker add` show **Re-queue task** instead: the queue row is put back as `pending` under its existing key, so the worker resumes the interrupted attempt's branch and report rather than opening a second branch and pull request. If the row was already pruned (30 days by default) or is still queued/running, the run detail explains why it cannot be re-queued and points at `devintern worker add`.

## Run an automation now

Open **Automations**, find the automation, and choose **Run now**. The worker runs it through the same pipeline as a scheduled occurrence, including its normal repository, environment, and overlap protection.

This is useful for testing a new automation prompt or running routine work early.

## View the dashboard without the worker

You can inspect existing run history even when the worker is stopped:

```bash
devintern dashboard
```

The command reads the local history without changing it. Use `--port <number>` if port 4400 is already occupied.

## Local by design

The dashboard and its data stay on the worker machine. It listens only on a loopback address, so it is not exposed to your network or the public internet.

Run history lives in the worker's workspace, alongside its other local state. The embedded dashboard remains available when an expired Worker Pilot pauses acquisition. Starting a standalone dashboard requires an active Worker Pilot or automation license.

To disable the dashboard or change its port, edit the workspace settings:

```toml
[workspace]
dashboard = false
# dashboard_port = 4400
```

## Artifacts

Run detail shows registered outputs with producing step, execution, commit, and
capture time. Preview text/Markdown and raster images, or download complete
files. Each attempt retains its own snapshots; unavailable files remain listed.
See [Pipeline artifacts](./artifacts.md) for capture and PR-comment publication.
