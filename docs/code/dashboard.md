---
title: "Worker Dashboard"
sidebarLabel: "Dashboard"
description: "See what the worker is doing, inspect failed runs, and retry work from a local dashboard"
section: "Automation"
order: 4
dateModified: 2026-10-30
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

The dashboard and its data stay on the worker machine. It listens only on a loopback address, so it is not exposed to your network or the public internet. There is no setting that binds it to another address: a non-loopback bind fails before the server starts, because the dashboard has no built-in authentication and its write endpoints retry runs and trigger automations.

Run history lives in the worker's workspace, alongside its other local state. The embedded dashboard remains available when an expired Worker Pilot pauses acquisition. Starting a standalone dashboard requires an active Worker Pilot or automation license.

To disable the dashboard or change its port, edit the workspace settings:

```toml
[workspace]
dashboard = false
# dashboard_port = 4400
```

## Access the dashboard from another device

Watching a long run from your laptop or phone does not require opening the dashboard port. Put an authenticating boundary in front of the loopback listener instead — your SSH client, your Tailscale tailnet, or a reverse proxy with its own login. All three options below leave the dashboard bound to `127.0.0.1`, and they work the same for the worker-embedded dashboard and for `devintern dashboard`.

**Treat the dashboard as sensitive.** Run transcripts, logs, and artifacts can contain credentials or customer data, and `POST /api/runs/:id/retry` and `POST /api/automations/:id/run` act with your repository credentials. That is why the recipes below add a login rather than just moving the bind address.

### Option 1: SSH tunnel

The smallest setup, and the right default when you only need access from another computer.

```bash
ssh -N -L 4400:127.0.0.1:4400 you@worker-host
```

Open [http://localhost:4400](http://localhost:4400) on your own machine and the traffic is forwarded over the SSH connection. Add `-f` to background the tunnel, or configure a `LocalForward 4400 127.0.0.1:4400` entry in `~/.ssh/config` to make it permanent. Mobile SSH clients such as Termius and Blink support local port forwarding too.

If port 4400 is busy locally, forward a different local port: `-L 8440:127.0.0.1:4400` and open `http://localhost:8440`.

### Option 2: Tailscale Serve

Best for phone and multi-device access. The dashboard becomes a private HTTPS origin on your tailnet, and no other device on the network can reach it.

```bash
tailscale serve --bg 4400
```

Tailscale terminates TLS and forwards to `http://127.0.0.1:4400`, so open the `https://<machine>.<tailnet>.ts.net/` URL the command prints. Only devices in your tailnet can connect, and Tailscale's device identity is the access boundary.

Do not use `tailscale funnel` for the dashboard. Funnel publishes the port on the public internet with no login prompt in front of it.

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

Generate the hash with `caddy hash-password`, then reload Caddy. Anything the proxy authenticates is forwarded to loopback, so the dashboard itself still refuses to listen on the LAN address.

Plain HTTP means the password and the dashboard data cross your network unencrypted. Do this only on a trusted internal network, and prefer Options 1 and 2 elsewhere. Add `tls internal` and use an `https://` site address if you want Caddy-managed certificates for a private hostname.

Whichever proxy you choose, it must authenticate every request itself; do not run an unauthenticated forwarder, and do not add a second listener that reaches the dashboard without a credential check.

## Artifacts

Run detail shows registered outputs with producing step, execution, commit, and
capture time. Preview text/Markdown and raster images, or download complete
files. Each attempt retains its own snapshots; unavailable files remain listed.
See [Pipeline artifacts](./artifacts.md) for capture and PR-comment publication.
