---
title: "Running the Worker Unattended"
description: "Choose when the worker picks up tasks and keep unattended runs healthy"
section: "Automation"
order: 5
sidebarHidden: true
dateModified: 2026-11-18
---

# Running the Worker Unattended

The [worker](./worker.md) is the unattended path for DevIntern Code. It keeps running, picks up ready tasks, watches the agent's pull requests, and receives instant events through the [relay](./relay.md). You do not need cron or another scheduler around the CLI.

```bash
devintern worker init   # workspace, ready-tasks query, relay pairing, and a user service
devintern worker
```

Where to find the details:

| Topic                                          | Page                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Polling, retries, and actioned tickets         | [Worker: Polling mode](./worker.md#polling-mode)                                            |
| Installing as a systemd or launchd service     | [Worker: Running as a service](./worker.md#running-as-a-service)                            |
| Worker Pilot and automation licenses           | [Worker: Worker Pilot and licenses](./worker.md#worker-pilot-and-licenses)                  |
| Failure comments and crash recovery            | [Re-running a task](./worker-troubleshooting.md#re-running-a-task), [Interrupted runs](./worker-troubleshooting.md#interrupted-runs) |
| Scheduled story-point estimation               | [Story Points Estimation](./story-points-estimation.md)                                     |
| Sandboxing unattended agent runs               | [Sandboxing the Agent](./configuration.md#sandboxing-the-agent)                             |

## Working windows (quiet hours)

Limit new-task pickup to chosen wall-clock windows, for example nights only, with `[worker.schedule]` in `workspace.toml`. Restart the worker after changing it.

```toml
[worker.schedule]
active = ["22:00-06:00"]   # pick up ready tasks only inside these windows
blocked = ["12:00-13:00"]  # optional; always wins over active
timezone = ""              # optional IANA name, e.g. "Europe/Berlin"; blank = machine local time
catch_up_missed = true     # drain once at startup if a whole window passed unused
```

- **Only new-task pickup pauses.** Review replies, @mentions, recurring automations, and relay events keep running. A task that already started finishes even if its window closes.
- **Windows** may cross midnight and combine when you list several. A start equal to the end is rejected.
- **Nothing is missed.** While paused, the worker does not query the tracker, so tasks created overnight are picked up on the first tick after the window opens.
- **Daylight saving.** Windows follow the clock: a start time skipped by "spring forward" fires at the next valid moment; a time repeated by "fall back" uses its second occurrence.
- **Catch-up.** If the machine slept through an entire window, the next worker start drains once. Set `catch_up_missed = false` to wait for the next window instead.

To drain once now, ignoring the windows:

```bash
devintern worker run-now
devintern worker run-now --workspace /path/to/workspace.toml
```

The running worker serves the request on its next poll (within `[defaults].poll_interval`, 60 seconds by default). If no worker is running, the request waits for the next worker start.

The startup banner shows the windows, timezone, and whether pickup is open. Each open/close change is logged once, and the [dashboard](./dashboard.md) header shows when the window next opens or closes.

## Keeping unattended runs healthy

- **Git push over SSH:** the service has no interactive SSH agent. Point the host at a key in `~/.ssh/config` (`Host github.com` / `IdentityFile ~/.ssh/your_key`), or use an HTTPS remote with `GITHUB_TOKEN`.
- **Leftover processes:** dev servers and watchers the agent starts are stopped when each run ends, times out, or is interrupted. No setup needed.
- **Hand-written service units:** pin `PATH` to include the directory with `bun` (`dirname "$(which bun)"`), or the service fails with `bun: command not found`.
