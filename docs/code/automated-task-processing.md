---
title: "Automated Task Processing"
description: "Drain your backlog continuously with the worker daemon"
section: "Server Automation"
order: 5
dateModified: 2026-08-27
---

# Automated Task Processing

Run @devintern/code without sitting at the keyboard. The unattended path is the [worker daemon](./worker.md): one long-running process that polls your tracker, runs ready tasks, watches the agent's PRs, and can receive events in seconds through the [relay](./relay.md). [Working windows (quiet hours)](#working-windows-quiet-hours) keep that process resident while limiting when it spends tokens.

```bash
devintern worker init
devintern worker
```

`worker init` writes a 1-repo [workspace](./workspaces.md), stores the ready-tasks query, checks any automation license (Supporter, Team, or Business), offers relay pairing, and can generate a user-level systemd unit (Linux) or launchd agent (macOS). Opening http://localhost:4400 is how you know it worked.

Do not schedule `devintern --query` every few minutes. That is what the worker already does.

## Requires an automation license

Unattended execution (the worker, a systemd timer, cron, or any CI environment) requires an **automation license** (Supporter, Team, or Business). When @devintern/code detects an automated context but finds no matching license, the run fails immediately with:

```
❌ License check failed
   Automated execution detected (CI / systemd / cron) but no
   automation license was found.
```

Set `LICENSE_KEY` in the workspace `.env` (or as an `Environment=` entry in a unit file) to an automation license key from [devintern.com/account](https://devintern.com/account). Interactive runs (`devintern PROJ-123` from your terminal) are unaffected and do **not** require a license. @devintern/code is free to use interactively under the FSL license.

## Working windows (quiet hours)

The worker can limit new-task pickup from your tracker to wall-clock windows you choose — for example, only at night or only outside working hours. Configure them in `[worker.schedule]` in `workspace.toml` and restart the worker:

```toml
[worker.schedule]
active = ["22:00-06:00"]        # drain ready tasks only during these windows (local time)
blocked = ["12:00-13:00"]       # optional: stay quiet during lunch even inside an active window
timezone = ""                   # optional IANA name ("America/New_York"); blank = machine local time
catch_up_missed = true          # drain once at startup when a whole window elapsed unused
```

How it behaves:

- **Only new-task pickup is gated.** The detect → evaluate → execute drain of the fleet query pauses; review replies, @mentions, recurring automations, relay events, and everything else continue exactly as before.
- **In-flight tasks finish.** Execution is sequential: once a task has been picked up it runs to completion even if its window closes mid-run. Nothing is killed at the window edge.
- **Multiple windows union.** `active = ["06:00-09:00", "18:00-23:00"]` opens two drain periods per day. Windows may cross midnight (`22:00-06:00`). A start equal to the end is rejected.
- **Blocked wins over active.** Overlapping entries resolve toward staying quiet — the safe direction for spend.
- **No cursor movement while paused.** Ticks that land inside a quiet window neither query the tracker nor advance cursors, so anything created overnight is detected on the first tick after the window opens.

### Timezones and DST

Windows are defined in **wall-clock time**. With no `timezone` set (the default), they follow the worker machine's local time, so "nights" mean *its* nights. Set any IANA name (for example `timezone = "Europe/Berlin"`) to pin the schedule independent of where the daemon runs; the resolved zone is printed in the startup banner and shown on the dashboard.

Daylight-saving transitions shift real window duration by up to an hour because windows track the clock, not absolute time:

- **Spring forward**: local times that do not exist snap forward to the next valid moment — a `02:30` start begins within about half an hour of the lost hour instead of never firing.
- **Fall back**: a wall time occurring twice is evaluated on its second (standard-time) pass.

### Missed windows and catch-up

If the laptop slept through an entire active window (`catch_up_missed = true`, the default), the next worker start drains once immediately instead of waiting for the next window. The check compares the persisted timestamp of the last executed drain against the most recent fully elapsed window; set `catch_up_missed = false` if you would rather skip strictly to the next scheduled one. Worker uptime is unaffected either way: catch-up triggers only on startup.

### Run now, without editing the schedule

`devintern worker run-now` asks the running worker for one immediate drain, ignoring the windows:

```bash
devintern worker run-now
devintern worker run-now --workspace /path/to/workspace.toml
```

The command writes a `.run-now` marker into the workspace home; the worker consumes it on its next poll tick (within `[defaults].poll_interval`, 60 seconds by default), drains, and removes the marker. Logs announce the manual run; the dashboard shows it as pending until served.

### Seeing the current state

- The startup banner lists the windows, the timezone, and whether pickup is currently open.
- Every open/close flip is logged exactly once: `🌙 [schedule] outside the working window … ` / `☀️ [schedule] working window opened …`.
- The [dashboard](./dashboard.md) header shows the active state plus when the window next opens or closes; `/api/worker` exposes the same snapshot as JSON (`schedule`).

The only CLI run still worth putting on a timer is story-point estimation, which the worker does not schedule yet — see [Story Points Estimation](./story-points-estimation.md). Omit `--pr-target-branch` there unless you intentionally want PRs against a non-default branch; the CLI detects `main`, `master`, or a custom default from the remote.

### Keeping unattended runs healthy

#### Pin `PATH` so the `bun` shebang resolves

The `devintern` binary is a `#!/usr/bin/env bun` script, so it needs **`bun` on `PATH`** to run. Services launched by init systems start with a minimal `PATH` that usually excludes wherever your version manager (mise, asdf, nvm) installed Bun, and then fail with `bun: command not found`. Pin `PATH` explicitly in the `[Service]` section, listing the directory that contains `bun` (and `devintern`):

```ini
[Service]
Environment="PATH=/home/youruser/.local/bin:/home/youruser/.local/share/mise/installs/bun/1.3.2/bin:/usr/local/bin:/usr/bin"
```

Confirm the path with `dirname "$(which bun)"`.

#### Running as a user service (no root)

Instead of system units under `/etc/systemd/system` (which need `sudo`), you can run entirely as your own user with **`systemctl --user`**: no root, and the unit can read your `~/.ssh` and version-manager installs directly. Place the unit in `~/.config/systemd/user/`, drop the `User=` line, and manage it with `systemctl --user enable --now <unit>.service`. To keep user services running after you log out, enable lingering once:

```bash
loginctl enable-linger "$USER"
```

`devintern worker init` already writes a user-level systemd unit (Linux) or launchd agent (macOS) for the resident worker.

#### Git push under automation

If your repo's remote is SSH (`git@github.com:...`), the unattended run needs the SSH key reachable without an interactive agent. The cleanest approach is a `~/.ssh/config` host entry pointing the host at the right key: plain `git push` then resolves it (no `GIT_SSH_COMMAND` needed):

```
Host github.com
  IdentityFile ~/.ssh/your_key
```

A `--user` service inherits your `$HOME` and reads this automatically; a system service with `User=` reads that user's `~/.ssh`. Alternatively, use an HTTPS remote with a `GITHUB_TOKEN`.

#### Cleaning up processes the agent leaves running

While working a task, the AI agent often starts long-running processes to verify its changes: dev servers (`npm run dev`, `vite`), watchers, `docker compose up`, and so on. If the agent does not stop them, they would otherwise outlive the run and pile up across every execution.

@devintern/code prevents this. Each agent is launched in its own process group, and the entire group (the agent plus anything it spawned) is torn down when the run ends, times out, or is interrupted — the same under the worker, systemd timers, cron, and macOS, so you do not need to do anything to enable it:

1. **In-process reaping (all platforms).** @devintern/code signals the whole process group on completion, on timeout, and on `SIGINT` / `SIGTERM` / `SIGHUP`. This protects schedulers without init-level cleanup of their own.
2. **systemd cgroup cleanup (Linux, bonus).** A systemd service confines all of its processes to a unit cgroup, and the default `KillMode=control-group` reaps that entire cgroup when the unit deactivates. This catches even processes that fully daemonize (call `setsid` themselves) and escape the process group.

If you wrap @devintern/code in a timer on Linux and want this daemon-proof guarantee from plain cron too, wrap the command in a transient scope so its children share one cgroup:

```bash
systemd-run --user --scope --collect devintern --estimate --query '...' >> /tmp/devintern-cron.log 2>&1
```

#### Failure feedback on the task tracker

A failed run never ends silently. When processing a task fails after it was moved to "In Progress" — an agent timeout, a usage limit, a crash, or the process being killed by `SIGTERM`/`SIGINT` (for example when a machine powers off) — @devintern/code posts a comment on the ticket explaining that no pull request was created, the reason for the failure, and where partial work may live (the `feature/<key>` branch or a git stash). The ticket is also moved back to its To Do status so the next pickup can retry it.

The failure comment will not cause a retry loop: posting it does bump the tracker's update stamp, but the retry gate ignores the harness's own comments and records the attempt, so the ticket is only re-run after you edit the description, post your own comment, or delete the failure comment (see [worker polling](./worker.md#re-running-a-task)).

Pass `--skip-comments` to disable all tracker comments, including failure feedback.
