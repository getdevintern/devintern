---
title: "Worker Daemon"
sidebarLabel: "Worker"
description: "Use when running DevIntern as a long-running worker that picks up tracker tasks, handles PR reviews and CI failures, and runs as a service."
section: "Automation"
order: 2
dateModified: 2026-11-18
---

# Worker Daemon

`devintern worker` runs DevIntern as a long-running daemon on your own machine. It picks up work for every repository in your [workspace](./workspaces.md) and runs it locally. Your code, credentials, and agent runs stay on your machine.

## What the worker handles

- **Tracker tasks** that match your ready-tasks query ([polling mode](#polling-mode)).
- **Recurring automations**: prompts run on a schedule. See [Recurring Automations](./automations.md).
- **Follow-up on pull requests**: review feedback, merge conflicts, CI failures, auto-merge, and `@mentions`. See [PR Follow-up](./pr-follow-up.md).
- **Scheduled story-point estimation**. See [Story Points Estimation](./story-points-estimation.md#scheduled-estimation-with-the-worker).
- **Production errors** from Sentry. See [Sentry Auto-fixes](./sentry-integration.md).
- **Ad-hoc tasks** you enqueue with `devintern worker add`. See [Delegate Tasks to the Worker](./delegation.md).

When something does not get picked up, see [Worker Troubleshooting](./worker-troubleshooting.md).

## Quick start

```bash
devintern worker init
```

`worker init` reuses tracker config from `devintern init` (or asks for it), writes a one-repo workspace, validates the ready-tasks query, and asks about task pickup hours, conflict handling, and CI repair. It can add a Sentry project, offers sign-in for the Worker Pilot if you have no license, pairs your repositories with the [relay](./relay.md), and offers to install the worker as a service. `--no-service` skips the service step.

For GitHub, install the central [DevIntern AI App](https://github.com/apps/devintern-ai/installations/new) on the workspace repositories. Its private key stays with DevIntern. Events reach your worker as reference-only envelopes, and your local `GITHUB_TOKEN` does the API work. After adding repositories, run `devintern worker connect` to pair them. Without the relay, polling still works; `@mention` handling then needs a [customer-owned GitHub App](./configuration.md#advanced-customer-owned-github-app).

To start a configured workspace by hand:

```bash
devintern worker                 # uses ~/.devintern/workspace.toml
devintern webhook serve          # advanced: repo-local GitHub webhook listener
```

## Checking readiness (`worker doctor`)

An idle healthy worker and an idle misconfigured one look the same. Run the doctor before starting, and after changing config, tokens, or trackers:

```bash
devintern worker doctor [--workspace <path>] [--offline]
```

It checks that `workspace.toml` parses, that there is something to acquire, tracker credentials per team, a dry run of each `task_query` (with match counts), access to each repository, your automation license, the agent harness and sandbox, and whether the dashboard port is free. Every failing row includes a fix hint. It exits 1 if any check fails. `--offline` skips network checks. The doctor never edits config or starts the worker.

## Polling mode

With `[defaults].task_query` set, the worker polls your tracker every `poll_interval` seconds (default 60) and runs every task that matches. The query uses your tracker's normal query language, so "ready" means whatever the query says. A task is picked up once per change: it re-enters only after it is updated again. Polling state survives restarts.

Polling works with all trackers. Some need one extra setting:

| Tracker        | Required for polling                         |
| -------------- | -------------------------------------------- |
| Trello         | `TRELLO_DEFAULT_BOARD_ID`                    |
| Asana          | `ASANA_DEFAULT_PROJECT_GID`                  |
| GitLab Issues  | `GITLAB_TOKEN` and `GITLAB_PROJECT`          |
| Markdown files | `MARKDOWN_TASKS_DIR` and `tracker = "markdown"` |

A folder of markdown tasks is the quickest way to try the worker without a tracker account. With several boards or tracker accounts, use [teams](./workspaces.md#multiple-teams-and-tracker-boards).

Each task runs through the normal pipeline with `[defaults].worker_task_args` (default `--create-pr`). After a PR is created the ticket is recorded as actioned and is not re-implemented until it changes; see [Tickets already actioned after a PR](./worker-troubleshooting.md#tickets-already-actioned-after-a-pr).

## Agent failover and sandboxing

Set `AGENT_HARNESS=codex,grok` (priority first) in the workspace `.env` so the worker keeps going when one agent hits a usage limit. Failover covers every worker job except schedules that pin their own `harness` ([details](./automations.md#choosing-the-agent-per-schedule)). When every harness is limited, task pickup pauses and due automations and estimations skip that occurrence. See [Failover across multiple harnesses](./agent-harness.md#failover-across-multiple-harnesses).

Unattended runs are where sandboxing matters most. Set `AGENT_SANDBOX=auto` in the workspace `.env`; see [Sandboxing the Agent](./sandboxing.md).

## Working windows (quiet hours)

Limit new-task pickup to certain hours with `[worker.schedule]`:

```toml
[worker.schedule]
active = ["22:00-06:00"]   # pickup allowed only inside these daily windows
blocked = []               # subtracted from active windows; wins on overlap
timezone = ""              # IANA name; blank = machine local time
catch_up_missed = true     # one catch-up drain if a whole window was missed
```

Windows may cross midnight, and several windows combine. Only new-task pickup pauses. Reviews, mentions, automations, and relay events keep running, and a task already started finishes after its window closes. `devintern worker run-now` forces one drain right away. Timezone, DST, and status details are in [Working windows](./automated-task-processing.md#working-windows-quiet-hours).

## Options

The daemon takes few flags. Durable settings live in [`workspace.toml`](./workspaces.md#the-workspace-file).

| Option               | Description                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `--workspace <path>` | Use this `workspace.toml` (default `~/.devintern/workspace.toml`, or `DEVINTERN_WORKSPACE_DIR`) |
| `-v, --verbose`      | Verbose logging                                                                                |
| `--no-update`        | Skip the self-update check for this run                                                        |

The worker serves the [dashboard](./dashboard.md) on `http://localhost:4400`. Set `[workspace].dashboard = false` to disable it or `[workspace].dashboard_port` to move it. `devintern dashboard` also works while the worker is stopped.

## Running as a service

At its last step `worker init` offers to install and start the worker as a service:

- **Linux**: a systemd user unit in `~/.config/systemd/user/`, enabled with `systemctl --user enable --now devintern-worker`. The wizard enables lingering so the worker starts after reboot without a login. If that fails, run `loginctl enable-linger` once.
- **macOS**: a launchd agent in `~/Library/LaunchAgents/`, started with `launchctl bootstrap`.

Both record your current `PATH`. If a step fails (for example, no systemd user session on WSL), the wizard rolls back and prints the manual commands. Re-running `worker init` updates a DevIntern-managed service in place and never overwrites a hand-written one.

A hand-written Linux unit looks like this. One service runs the whole workspace:

```ini
[Unit]
Description=DevIntern fleet worker
After=network-online.target

[Service]
ExecStart=/usr/local/bin/devintern worker
Restart=on-failure
WorkingDirectory=/home/you/.devintern

[Install]
WantedBy=multi-user.target
```

On Windows, run `devintern worker` in a terminal. For `PATH` pinning and git push credentials under a service, see [Keeping unattended runs healthy](./automated-task-processing.md#keeping-unattended-runs-healthy).

## Keeping the worker up to date

When `devintern` is installed globally (npm or bun `-g`), the worker checks for a new version at most once a day. When it finds one and is idle, it installs the update and restarts. Running jobs are never interrupted, and a failed update leaves the current version running.

Source checkouts, `bun link`, and local installs are never updated. To opt out, set `DEVINTERN_NO_UPDATE=1`, pass `--no-update`, or add this to `workspace.toml` (applies without a restart):

```toml
[worker]
auto_update = false
```

A hand-written launchd agent must set `DEVINTERN_SERVICE=1` in its `EnvironmentVariables` so the worker exits and lets launchd restart it after an update. The generated definitions already do this.

## Worker Pilot and licenses

The no-card **Worker Pilot** gives a signed-in user 14 days of unattended use with no task-count limit. It starts when the worker first starts with a valid workspace. Run `devintern login`, then `devintern worker`.

After the pilot, the worker needs an automation license (Supporter, Team, or Business). A paid `LICENSE_KEY` does not need a login. If access expires while running, in-flight work finishes and new pickup pauses until a license is added. Interactive CLI use stays free.
