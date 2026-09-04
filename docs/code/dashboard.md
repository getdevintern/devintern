---
title: "Worker Dashboard"
sidebarLabel: "Dashboard"
description: "See what the worker is doing, inspect failed runs, and retry work from a local dashboard"
section: "Automation"
order: 2
sidebarHidden: true
dateModified: 2026-09-01
---

# Worker Dashboard

The dashboard answers a simple question: **what has the worker been doing?** It gives you a local view of current and past runs without making you read terminal output or inspect the worker database.

It starts automatically with `devintern worker`. Open [http://localhost:4400](http://localhost:4400) on the machine running the worker.

## What you can do

- See whether the worker is running, waiting for its next working window, or processing a task
- Follow each run from task pickup through implementation and pull request creation
- Open the task or pull request behind a run
- Understand why a run failed and retry it after fixing the cause
- Run a recurring automation immediately instead of waiting for its next scheduled time
- Review recent worker logs when something needs attention

The overview also summarizes activity and success rates, which is useful for spotting repeated failures without checking every run individually.

## Retry a failed run

Open the failed run and choose **Retry**. The worker queues a fresh attempt using the same task and workspace routing rules.

Retry after correcting the underlying problem, for example missing credentials, unclear task details, or a temporary agent failure. The dashboard prevents duplicate retries while another attempt is already queued or running.

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

Run history lives in the worker's workspace, alongside its other local state. The dashboard is included with the same automation license or active trial required by the worker.

To disable the dashboard or change its port, edit the workspace settings:

```toml
[workspace]
dashboard = false
# dashboard_port = 4400
```
