---
title: "Automated Task Processing"
description: "Drain your backlog continuously with the worker daemon"
section: "Server Automation"
order: 5
dateModified: 2026-09-01
---

# Automated Task Processing

Run @devintern/code without sitting at the keyboard. The unattended path is the [worker daemon](./worker.md): one long-running process that polls your tracker, runs ready tasks, watches the agent's PRs, and can receive events in seconds through the [relay](./relay.md).

```bash
devintern worker init
devintern worker
```

`worker init` writes a 1-repo [workspace](./workspaces.md), stores the ready-tasks query, checks any automation license (Supporter, Team, or Business), offers relay pairing plus the central DevIntern AI App (`@mention` handling on any PR, with `GITHUB_TOKEN` retained for local API access), and can generate a user-level systemd unit (Linux) or launchd agent (macOS). Opening http://localhost:4400 is how you know it worked. Air-gapped/no-relay installations use the separate customer-owned App workflow.

Do not schedule `devintern --query` every few minutes. That is what the worker already does.

## Requires an automation license

Unattended execution (the worker, a systemd timer, cron, or any CI environment) requires an **automation license** (Supporter, Team, or Business). When @devintern/code detects an automated context but finds no matching license, the run fails immediately with:

```
❌ License check failed
   Automated execution detected (CI / systemd / cron) but no
   automation license was found.
```

Set `LICENSE_KEY` in the workspace `.env` (or as an `Environment=` entry in a unit file) to an automation license key from [devintern.com/account](https://devintern.com/account). Interactive runs (`devintern PROJ-123` from your terminal) are unaffected and do **not** require a license. @devintern/code is free to use interactively under the FSL license.

## Night-only CLI runs

The worker polls whenever it is running. If you need a wall-clock window (for example only at night) until the worker has quiet hours, you can still fire a one-shot `devintern --query` from a systemd timer or crontab. This is a gap filler, not a second product.

Story-point estimation is the other remaining one-shot: see [Story Points Estimation](./story-points-estimation.md).

Omit `--pr-target-branch` unless you intentionally want PRs against a non-default branch — the CLI detects `main`, `master`, or a custom default from the remote.

### systemd timer (Linux)

A systemd job is a pair of unit files: a one-shot `.service` that runs `devintern`, and a `.timer` that triggers it on a schedule. This example drains Intern-labeled work at 22:00 every night.

`/etc/systemd/system/devintern-nightly.service`:

```ini
[Unit]
Description=Nightly Intern-labeled drain with @devintern/code
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

`/etc/systemd/system/devintern-nightly.timer`:

```ini
[Unit]
Description=Run @devintern/code at 22:00

[Timer]
OnCalendar=*-*-* 22:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable, start, and inspect:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now devintern-nightly.timer

# Show next scheduled run
systemctl list-timers devintern-nightly.timer

# Tail recent runs
journalctl -u devintern-nightly.service -f
```

### Cron

If you're on a system without systemd, the same night window works as a crontab entry:

```bash
# Drain Intern-labeled tasks in open sprints at 22:00
0 22 * * * cd /path/to/your/project && devintern --query 'statusCategory = "To Do" AND sprint in openSprints() AND labels IN (Intern) ORDER BY created DESC' --max-turns 500 --create-pr >> /tmp/devintern-cron.log 2>&1
```

### Pin `PATH` so the `bun` shebang resolves

The `devintern` binary is a `#!/usr/bin/env bun` script, so it needs **`bun` on `PATH`** to run. systemd services start with a minimal `PATH` that usually excludes wherever your version manager (mise, asdf, nvm) installed Bun. The unit then fails with `bun: command not found` (or silently can't find `devintern` itself). Pin `PATH` explicitly in the `[Service]` section, listing the directory that contains `bun` (and `devintern`):

```ini
[Service]
Environment="PATH=/home/youruser/.local/bin:/home/youruser/.local/share/mise/installs/bun/1.3.2/bin:/usr/local/bin:/usr/bin"
```

Confirm the path with `dirname "$(which bun)"`. The same applies to cron, which also runs with a stripped `PATH`: either set `PATH=` at the top of the crontab or call `devintern` by absolute path.

### Running as a user service (no root)

The examples above install to `/etc/systemd/system` (system-wide, needs `sudo`). You can instead run entirely as your own user with **`systemctl --user`**: no root, and the unit can read your `~/.ssh` and version-manager installs directly. Place the unit in `~/.config/systemd/user/`, drop the `User=` line, and manage it with `systemctl --user enable --now <unit>.timer`. To keep user services running after you log out, enable lingering once:

```bash
loginctl enable-linger "$USER"
```

For a resident worker rather than a night timer, `devintern worker init` already writes a user-level systemd unit or macOS launchd agent.

### Git push under automation

If your repo's remote is SSH (`git@github.com:...`), the unattended run needs the SSH key reachable without an interactive agent. The cleanest approach is a `~/.ssh/config` host entry pointing the host at the right key: plain `git push` then resolves it (no `GIT_SSH_COMMAND` needed):

```
Host github.com
  IdentityFile ~/.ssh/your_key
```

A `--user` service inherits your `$HOME` and reads this automatically; a system service with `User=` reads that user's `~/.ssh`. Alternatively, use an HTTPS remote with a `GITHUB_TOKEN`.

### Cleaning up processes the agent leaves running

While working a task, the AI agent often starts long-running processes to verify its changes: dev servers (`npm run dev`, `vite`), watchers, `docker compose up`, and so on. If the agent does not stop them, they would otherwise outlive the run and pile up across every scheduled execution.

@devintern/code prevents this. Each agent is launched in its own process group, and the entire group (the agent plus anything it spawned) is torn down when the run ends, times out, or is interrupted. This works the same under the worker, systemd, cron, and macOS, so you do not need to do anything to enable it.

Two layers back this up:

1. **In-process reaping (all platforms).** @devintern/code signals the whole process group on completion, on timeout, and on `SIGINT` / `SIGTERM` / `SIGHUP`. This is what protects cron jobs and macOS, which have no init-level cleanup of their own.
2. **systemd cgroup cleanup (Linux, bonus).** A systemd service confines all of its processes to a unit cgroup, and the default `KillMode=control-group` reaps that entire cgroup when the unit deactivates. This catches even processes that fully daemonize (call `setsid` themselves) and so escape the process group. No extra configuration is required: any process the agent leaves behind is cleaned up when the oneshot service exits.

If you run @devintern/code under cron on Linux and want the same daemon-proof guarantee systemd gives, wrap the command in a transient scope so its children share one cgroup:

```bash
0 22 * * * cd /path/to/your/project && systemd-run --user --scope --collect devintern --query '...' --create-pr >> /tmp/devintern-cron.log 2>&1
```

### Failure feedback on the task tracker

A failed run never ends silently. When processing a task fails after it was moved to "In Progress" — an agent timeout, a usage limit, a crash, or the process being killed by `SIGTERM`/`SIGINT` (for example when a scheduler stops the job) — @devintern/code posts a comment on the ticket explaining that no pull request was created, the reason for the failure, and where partial work may live (the `feature/<key>` branch or a git stash). The ticket is also moved back to its To Do status so the next scheduled run can retry it.

The failure comment will not cause a retry loop: posting it does bump the tracker's update stamp, but the retry gate ignores the harness's own comments and records the attempt, so the ticket is only re-run after you edit the description, post your own comment, or delete the failure comment (see [worker polling](./worker.md#re-running-a-task)).

That covers graceful stops. When the worker itself dies mid-task (power cut, crash, `kill -9`), no comment could be posted at the time — so on its next startup the worker detects the runs left in flight, comments on their tickets with the same failure explanation, and moves them back to To Do. Tickets that moved on after the crash and orphans older than `WORKER_ORPHAN_MAX_AGE_HOURS` (default 168) are left alone. See [Interrupted runs are recovered on startup](./worker.md#interrupted-runs-are-recovered-on-startup).

Pass `--skip-comments` to disable all tracker comments, including failure feedback.

### Linear schedules

For Linear (`TASK_TRACKER=linear`), swap JQL for a JSON `IssueFilter`. Wrap the JSON in single quotes so the shell passes it through unchanged:

```ini
# systemd service: nightly "intern"-labeled drain
ExecStart=/usr/local/bin/devintern \
  --query '{"labels":{"name":{"eq":"intern"}}}' \
  --max-turns 500 \
  --create-pr
```

```bash
# cron: nightly "intern"-labeled Linear drain
0 22 * * * cd /path/to/your/project && devintern --query '{"labels":{"name":{"eq":"intern"}}}' --max-turns 500 --create-pr >> /tmp/devintern-cron.log 2>&1
```

### Notes for timer runs

- Set `WorkingDirectory` (systemd) or `cd` (cron) to your project directory so the correct `.devintern-code/.env` is loaded
- Use absolute paths to the `devintern` and agent binaries, or pin `PATH` explicitly in the unit file (see above)
- Set `LICENSE_KEY` to an automation license key (Supporter, Team, or Business): unattended runs fail the license check without it
- `--query` is the preferred flag; `--jql` still works but emits a deprecation warning
- For systemd, `journalctl -u <unit>` gives you logs; for cron, redirect stdout/stderr to a log file
- For Jira, use `ORDER BY created DESC` to process newest tasks first
- Test your query manually before scheduling (JQL in Jira's issue search; JSON `IssueFilter` in Linear's API explorer)
