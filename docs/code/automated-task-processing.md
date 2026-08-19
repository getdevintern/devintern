---
title: "Automated Task Processing"
description: "Drain your backlog continuously with the worker daemon, or schedule @devintern/code via systemd timers or cron"
section: "Server Automation"
order: 5
dateModified: 2026-08-19
---

# Automated Task Processing

Run @devintern/code without manual intervention.

> **Recommended: the worker daemon.** `devintern worker --query "<ready-tasks query>"` replaces timer and cron wiring with a single long-running process: it polls your tracker, runs ready tasks, and watches the agent's PRs for review feedback, with persistent cursors and crash-safe state. One systemd `.service` (no `.timer` needed), or just a terminal. See the [Worker Daemon guide](./worker.md).

The scheduled one-shot approach below still works everywhere and remains useful when you prefer runs at fixed times (for example, only at night) rather than a resident process. On modern Linux servers the recommended scheduler is **systemd timers**: structured logs via `journalctl`, restart-on-failure semantics, and no root crontab access required. **Cron** still works on any Unix-like system and is shown second as a fallback (macOS, BSD, Alpine, containers without an init system).

## Requires an automation license

Unattended execution (the worker, systemd, cron, or any CI environment) requires an **automation license** (Supporter, Team, or Business). When @devintern/code detects an automated context but finds no matching license, the run fails immediately with:

```
❌ License check failed
   Automated execution detected (CI / systemd / cron) but no
   automation license was found.
```

Set `LICENSE_KEY` in your project's `.devintern-code/.env` (or as an `Environment=` entry in the unit file) to an automation license key (Supporter, Team, or Business) from [devintern.com/account](https://devintern.com/account). Interactive runs (`devintern PROJ-123` from your terminal) are unaffected and do **not** require a license. @devintern/code is free to use interactively under the FSL license.

## systemd timers

A systemd job is a pair of unit files: a one-shot `.service` that runs `devintern`, and a `.timer` that triggers it on a schedule. Omit `--pr-target-branch` unless you intentionally want PRs against a non-default branch — the CLI detects `main`, `master`, or a custom default from the remote.

### Every 10 minutes: process Intern-labeled tasks

`/etc/systemd/system/devintern-intern.service`:

```ini
[Unit]
Description=Process Intern-labeled tasks with @devintern/code
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=devintern
WorkingDirectory=/path/to/your/project
ExecStart=/usr/local/bin/devintern \
  --query 'statusCategory = "To Do" AND sprint in openSprints() AND labels IN (Intern) ORDER BY created DESC' \
  --max-turns 500 \
  --create-pr
StandardOutput=journal
StandardError=journal
```

`/etc/systemd/system/devintern-intern.timer`:

```ini
[Unit]
Description=Run @devintern/code every 10 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
Persistent=true

[Install]
WantedBy=timers.target
```

Enable, start, and inspect:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now devintern-intern.timer

# Show next scheduled run
systemctl list-timers devintern-intern.timer

# Tail recent runs
journalctl -u devintern-intern.service -f
```

### Hourly: process AutoImpl-labeled tasks

Same `.service` shape, swap the `ExecStart` JQL:

```ini
ExecStart=/usr/local/bin/devintern \
  --query 'status = "To Do" AND labels IN (AutoImpl)' \
  --create-pr
```

And use an hourly timer:

```ini
[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
```

### Twice daily: high-priority bug sweep

For wall-clock schedules, use `OnCalendar` instead of `OnUnitActiveSec`. This timer fires at 09:00 and 17:00 every day:

```ini
[Timer]
OnCalendar=*-*-* 09,17:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Matching `.service`:

```ini
ExecStart=/usr/local/bin/devintern \
  --query 'type = Bug AND priority = High AND status = "To Do" AND labels IN (Intern)' \
  --max-turns 300 \
  --create-pr
```

## Cron

If you're on a system without systemd, the same three jobs work as crontab entries:

```bash
# Process tasks labeled "Intern" in open sprints every 10 minutes
*/10 * * * * cd /path/to/your/project && devintern --query 'statusCategory = "To Do" AND sprint in openSprints() AND labels IN (Intern) ORDER BY created DESC' --max-turns 500 --create-pr >> /tmp/devintern-cron.log 2>&1

# Process AutoImpl-labeled tasks every hour
0 * * * * cd /path/to/your/project && devintern --query 'status = "To Do" AND labels IN (AutoImpl)' --create-pr >> /tmp/devintern-cron.log 2>&1

# Process high-priority bugs twice daily
0 9,17 * * * cd /path/to/your/project && devintern --query 'type = Bug AND priority = High AND status = "To Do" AND labels IN (Intern)' --max-turns 300 --create-pr >> /tmp/devintern-cron.log 2>&1
```

## Pin `PATH` so the `bun` shebang resolves

The `devintern` binary is a `#!/usr/bin/env bun` script, so it needs **`bun` on `PATH`** to run. systemd services start with a minimal `PATH` that usually excludes wherever your version manager (mise, asdf, nvm) installed Bun. The unit then fails with `bun: command not found` (or silently can't find `devintern` itself). Pin `PATH` explicitly in the `[Service]` section, listing the directory that contains `bun` (and `devintern`):

```ini
[Service]
Environment="PATH=/home/youruser/.local/bin:/home/youruser/.local/share/mise/installs/bun/1.3.2/bin:/usr/local/bin:/usr/bin"
```

Confirm the path with `dirname "$(which bun)"`. The same applies to cron, which also runs with a stripped `PATH`: either set `PATH=` at the top of the crontab or call `devintern` by absolute path.

## Running as a user service (no root)

The examples above install to `/etc/systemd/system` (system-wide, needs `sudo`). You can instead run entirely as your own user with **`systemctl --user`**: no root, and the unit can read your `~/.ssh` and version-manager installs directly. Place the unit in `~/.config/systemd/user/`, drop the `User=` line, and manage it with `systemctl --user enable --now <unit>.timer`. To keep user services running after you log out, enable lingering once:

```bash
loginctl enable-linger "$USER"
```

## Git push under automation

If your repo's remote is SSH (`git@github.com:...`), the unattended run needs the SSH key reachable without an interactive agent. The cleanest approach is a `~/.ssh/config` host entry pointing the host at the right key: plain `git push` then resolves it (no `GIT_SSH_COMMAND` needed):

```
Host github.com
  IdentityFile ~/.ssh/your_key
```

A `--user` service inherits your `$HOME` and reads this automatically; a system service with `User=` reads that user's `~/.ssh`. Alternatively, use an HTTPS remote with a `GITHUB_TOKEN`.

## Cleaning up processes the agent leaves running

While working a task, the AI agent often starts long-running processes to verify its changes: dev servers (`npm run dev`, `vite`), watchers, `docker compose up`, and so on. If the agent does not stop them, they would otherwise outlive the run and pile up across every scheduled execution.

@devintern/code prevents this. Each agent is launched in its own process group, and the entire group (the agent plus anything it spawned) is torn down when the run ends, times out, or is interrupted. This works the same under systemd, cron, and macOS, so you do not need to do anything to enable it.

Two layers back this up:

1. **In-process reaping (all platforms).** @devintern/code signals the whole process group on completion, on timeout, and on `SIGINT` / `SIGTERM` / `SIGHUP`. This is what protects cron jobs and macOS, which have no init-level cleanup of their own.
2. **systemd cgroup cleanup (Linux, bonus).** A systemd service confines all of its processes to a unit cgroup, and the default `KillMode=control-group` reaps that entire cgroup when the unit deactivates. This catches even processes that fully daemonize (call `setsid` themselves) and so escape the process group. No extra configuration is required: any process the agent leaves behind is cleaned up when the oneshot service exits.

If you run @devintern/code under cron on Linux and want the same daemon-proof guarantee systemd gives, wrap the command in a transient scope so its children share one cgroup:

```bash
*/10 * * * * cd /path/to/your/project && systemd-run --user --scope --collect devintern --query '...' --create-pr >> /tmp/devintern-cron.log 2>&1
```

## Linear schedules

For Linear (`TASK_TRACKER=linear`), swap JQL for a JSON `IssueFilter`. Wrap the JSON in single quotes so the shell passes it through unchanged:

```ini
# systemd service: process "intern"-labeled issues every 10 minutes
ExecStart=/usr/local/bin/devintern \
  --query '{"labels":{"name":{"eq":"intern"}}}' \
  --max-turns 500 \
  --create-pr
```

```bash
# cron: process "intern"-labeled Linear issues every 10 minutes
*/10 * * * * cd /path/to/your/project && devintern --query '{"labels":{"name":{"eq":"intern"}}}' --max-turns 500 --create-pr >> /tmp/devintern-cron.log 2>&1

# cron: process high-priority issues assigned to me every hour
0 * * * * cd /path/to/your/project && devintern --query '{"assignee":{"isMe":{"eq":true}},"priority":{"lte":2}}' --create-pr >> /tmp/devintern-cron.log 2>&1
```

## Important Notes

- Set `WorkingDirectory` (systemd) or `cd` (cron) to your project directory so the correct `.devintern-code/.env` is loaded
- Use absolute paths to the `devintern` and agent binaries, or pin `PATH` explicitly in the unit file (see above)
- Set `LICENSE_KEY` to an automation license key (Supporter, Team, or Business): unattended runs fail the license check without it
- `--query` is the preferred flag; `--jql` still works but emits a deprecation warning
- For systemd, `journalctl -u <unit>` gives you logs; for cron, redirect stdout/stderr to a log file
- For Jira, use `ORDER BY created DESC` to process newest tasks first
- Test your query manually before scheduling (JQL in Jira's issue search; JSON `IssueFilter` in Linear's API explorer)
