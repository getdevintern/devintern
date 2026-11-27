---
title: "Worker Troubleshooting"
sidebarLabel: "Worker Troubleshooting"
description: "Use when the worker service keeps failing or stops at logout, or a worker task did not run, ran again, or failed: retrying tickets, actioned tickets, interrupted runs, pickup log messages, and reading worker logs."
section: "Automation"
order: 2.3
dateModified: 2026-11-27
---

# Worker Troubleshooting

Start with `devintern worker doctor` ([details](./worker.md#checking-readiness-worker-doctor)). It catches most configuration problems before the worker runs. For automation-specific problems, see [Recurring Automations → Troubleshooting](./automations.md#troubleshooting).

## Setup stopped partway

If `devintern worker init` was interrupted (Ctrl+C or Ctrl+D), run it again. It keeps what was already saved and finishes the setup, even if the workspace still names a different tracker from before the query step. A workspace that already has a ready-tasks query keeps its tracker; change it by hand in `workspace.toml`.

If `worker doctor` reports `Markdown tasks directory not found: ./tasks`, the folder was saved as a relative path by an older version. Set `MARKDOWN_TASKS_DIR` in `~/.devintern/.env` to the folder's absolute path.

If `worker doctor` reports `Agent harness — <harness>: AGENT_CLI_PATH=<path> (set in <file>) does not exist` (or `is not executable`), the agent CLI path in that file is wrong. Fix it there, or remove the line to use the CLI on your `PATH`. Doctor checks the same files a worker task reads: `~/.devintern/.env`, then the repository's `env_file` (for example `~/.devintern/env/<repo>.env`) and `[repos.env]`, then, for tasks a team picks up, that team's `env_file` and `[teams.env]`, with later ones winning. A problem that only affects one team's tasks is reported as `repo "<repo>" (team "<team>")`.

If it warns `worker failover: Harness "<harness>" is not installed`, the worker skips that `AGENT_HARNESS` entry. The worker chooses its failover entries using `~/.devintern/.env` only, so set that harness's `<HARNESS>_CLI_PATH` there, not in a repository `env_file` or `[repos.env]`.

If it warns `<harness>: after failover the task runs AGENT_CLI_PATH=<path>`, worker tasks that fail over to that harness would start the primary's CLI. Replace `AGENT_CLI_PATH` with the primary harness's own path key (for example `CLAUDE_CODE_CLI_PATH`).

## `devintern: command not found` over SSH or in cron

The installer writes the `PATH` line to `~/.bashrc` on Linux bash (below Debian's non-interactive guard), to `~/.bash_profile` on macOS bash, and to `~/.zshrc` or `~/.config/fish/config.fish` for zsh and fish. Shells that never read that file still miss `~/.bun/bin`, so fix each context where it happens:

| Context                                                        | Fix                                                                                                                                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login shell (`bash -lc`, `zsh -lc`, or `ssh host` then typing) | Add `export PATH="$HOME/.bun/bin:$PATH"` to the file your login shell reads: `~/.bash_profile` or `~/.profile` for bash, `~/.zprofile` or `~/.zshenv` for zsh. Fish has no `export`: add `fish_add_path "$HOME/.bun/bin"` to `~/.config/fish/config.fish` (or run it once) |
| cron                                                           | Put `PATH=/home/<user>/.bun/bin:/usr/local/bin:/usr/bin:/bin` at the top of the crontab, or call `devintern` by absolute path                                                                                  |
| SSH one-liner (`ssh host 'devintern …'`)                       | Use the absolute path (`~/.bun/bin/devintern …`), or put a literal `PATH=/home/<user>/.bun/bin:/usr/local/bin:/usr/bin:/bin` line in `~/.ssh/environment` and set `PermitUserEnvironment yes` in `sshd_config` |

`~/.ssh/environment` is parsed by sshd, not by a shell: each line is split at the first `=` and nothing is expanded, so write the real path with no `$HOME`/`$PATH` and no `export`. To use `BASH_ENV` instead, it must already be in the environment sshd starts the shell with: put `BASH_ENV=/home/<user>/.devintern-path` in `~/.ssh/environment` (or in `SetEnvironment` in `sshd_config`), then create that file with `export PATH="$HOME/.bun/bin:$PATH"`.

The systemd service is not affected: `worker service install` pins `PATH` in the unit.

## The service keeps failing

Run `devintern worker service status`. It shows the service state and, when the last start failed, the reason the worker printed.

| State        | Meaning and fix                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `failed`     | The worker cannot start with this setup (no license, nobody signed in, invalid `workspace.toml`), so the service stopped retrying. Fix what it names (`devintern worker doctor` lists every problem), then run `devintern worker service restart` |
| `restarting` | The worker exited for another reason, and the service starts it again after 30 seconds. Read the last lines with `devintern worker logs --level error` |
| `starting`   | The service is up, but the worker has not finished starting (first start, orphan recovery, slow network). Check again in a minute |
| `stopped`    | Stopped by you or at logout. Start it with `devintern worker service start`. If it stops at every logout, see [lingering](#the-worker-stops-when-you-log-out) |

Startup failures are written to `worker.stderr.log` in the workspace home, so `devintern worker logs` and the dashboard show them too. Output from before the worker could log at all (for example a missing Bun runtime) is only in the service manager's log: `devintern worker service logs`.

If `worker service install` says the worker would not start, it did not install anything. Fix the checks it lists and run it again. `--force` installs anyway, and the service then fails until the checks pass.

## The agent CLI fails to start

When the agent CLI exits right away without output (an invalid API key, a missing login, a broken install), the worker does not count it as a task attempt. It retries the task with growing waits (1, 2, 4, 8 minutes, up to 30). After 5 failed starts in a row, the task's run is marked `failed`, and you get a notification. The service still says `running` during all this, so check:

- `devintern worker status`, `devintern worker service status`, and `devintern worker queue` list each affected task under `Agent start` with the agent's error and a fix, for example `Fix: run claude once in a terminal to log in, or check ANTHROPIC_API_KEY`.
- `devintern worker logs --level error` has the full message.

Fix the agent as the user the worker runs as (log in, or set the API key in `~/.devintern/.env`). Then retry any task that gave up: use the dashboard's Retry, update the ticket, or run `devintern worker add --resume <task>` for an ad-hoc task. To try again right away instead of waiting out the backoff, run `devintern worker service restart`.

| Setting                             | Default | Meaning                                                           |
| ----------------------------------- | ------- | ----------------------------------------------------------------- |
| `DEVINTERN_AGENT_START_MAX_ATTEMPTS` | `5`     | Failed starts in a row before a task is marked `failed`           |

## The worker stops when you log out

A systemd user service runs only while you are logged in, unless lingering is enabled for your user. `worker service install` enables it. When that needs root (no polkit agent, an SSH session without a login), it warns and prints the command; run it once:

```bash
sudo loginctl enable-linger <user>
```

Then the worker starts at boot and keeps running after logout.

## "The systemd user manager is not running"

`worker service install` talks to your systemd user manager. Shells without a login session (`docker exec`, `sudo -u <user>`, `su`) do not set `XDG_RUNTIME_DIR`; DevIntern finds the manager's socket under `/run/user/<uid>` on its own. When that directory does not exist, the manager is not running: run `sudo loginctl enable-linger <user>` and install again. If it still cannot connect, export the two variables the message names (`XDG_RUNTIME_DIR=/run/user/<uid>` and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`).

## Re-running a task

When a run cannot finish, DevIntern comments on the ticket and moves it back to your to-do status. To avoid a retry loop, an unchanged ticket is not retried. Unlock a retry by changing the ticket:

- edit the description,
- post any comment (a one-line clarification is enough), or
- delete the bot's failure comment.

The bot's own comments and status changes never count as a change. On the retry the agent is told why the last attempt stopped and which comments are new. If the last attempt left a branch with commits, the retry continues on that branch instead of starting over.

To redo a run that completed, move the ticket back to your to-do status, optionally with a comment describing what to change. For a one-off local run, `devintern TASK-123 --force` re-runs a task even if nothing changed. Do not put `--force` in `[defaults].worker_task_args`, since it would disable the check for every polled task.

## Tickets already actioned after a PR

Once the worker opens a PR for a ticket, it records the ticket as **actioned** and skips it, even if it still matches `task_query`. This stops label-based trackers (GitHub, GitLab) from re-implementing an open issue in a loop. If `pr_status` is set under `[trackers]` in `workspace.toml`, the ticket is also moved to that status. The record is kept even if that move fails.

A ticket re-arms when you:

- edit its summary or description,
- re-open it, or
- add or remove a label.

A successful run that cannot create a PR at all (the remote is not GitHub, GitLab, or Bitbucket, or `worker_task_args` omits `--create-pr`) is recorded the same way.

When PR creation fails for a temporary reason (a GitHub 5xx, a rate limit), the worker comments on the ticket and re-runs the whole ticket on the next poll, up to 3 times. A failure that needs a human fix (a missing token or App, a validation error) is recorded as actioned right away; fix the configuration, then edit the ticket.

Either way, the run is recorded as `failed` with the reason `pushed but PR creation failed: …`, so `devintern worker runs --status failed` lists it.

## Interrupted runs

A graceful stop (Ctrl-C, `SIGTERM`) comments on in-flight tickets and moves them back to To Do. After a hard crash (power loss, `kill -9`), the worker does the same at its next startup, before picking up new work. If the interrupted run already had commits on its branch, the worker continues it instead. Ad-hoc tasks (`devintern worker add`) interrupted by a stop or restart resume at the next start; one that still ended `failed` can be re-queued with `devintern worker add --resume <task>`.

Tickets that someone moved out of In Progress after the crash are left alone. Runs older than 7 days are marked failed without a comment; change the cutoff with `WORKER_ORPHAN_MAX_AGE_HOURS` in the workspace `.env` (`0` disables the comments). Recovered tickets are not re-run automatically; they follow the [retry rules](#re-running-a-task).

## Ticket matches the query but is not picked up

Search the worker log for `[poll:<tracker>]` lines (for example `[poll:jira]`):

| Log line                                                         | Meaning and fix                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `📌 picking up KEY`                                              | Picked up on this poll.                                                                                      |
| `⏳ KEY deferred; will retry next poll`                          | The repository was busy. It is retried automatically.                                                        |
| `⏳ pickup paused: no agent harness is available until …`        | Every harness in `AGENT_HARNESS` is usage-limited. Pickup resumes when a limit resets.                       |
| `⏭️ KEY skipped (previous attempt reported incomplete; ticket unchanged)` | Edit or comment on the ticket to [retry it](#re-running-a-task).                                    |
| `⏭️ skipping KEY (already processed at this update)`             | Already picked up at this version. Edit or comment on it.                                                    |
| `⏭️ skipping KEY (already actioned; no change since the PR)`     | A PR already exists. See [Tickets already actioned after a PR](#tickets-already-actioned-after-a-pr).        |
| `have no update stamp from the tracker`                          | The tracker's search results lack an `updated` field, so retries cannot be detected. Run `devintern KEY` by hand. |
| No `[poll:…]` lines at all                                       | Nothing changed on the tracker since the last poll. Edit the ticket.                                         |
| `⏳ KEY waiting: …` / `⛔ KEY blocked: …`                         | Held back by its [blockers](./worker.md#ticket-dependencies). `devintern worker queue` shows the reason.      |
| `⏳ KEY waiting: could not read KEY's blockers from …`            | The tracker refused the blocker read. Check that the token can read issue links (Jira, GitLab), relations (Linear), work item links (Azure DevOps), dependencies (Asana), or the blocker cards (Trello). The ticket starts once the read succeeds. |
| `GitHub token cannot read issue dependencies … (403)`            | The `GITHUB_TOKEN` cannot read issue dependencies, so issues run without waiting on blockers. Grant the token read access to issues in that repository. |

An edit made while the ticket's run is in progress is remembered and picked up after the run ends.

In a multi-repo workspace, a task whose routing rules match no repository, or more than one, is recorded as skipped. Fix the [routing rules](./workspaces.md#routing-tasks-to-repositories) or the task's labels, then edit the task.

## Runs that fail at delivery

A run fails, and no PR is created, when it leaves nothing to publish (no changes and no new commits), fails pre-push validation, or cannot push its branch. Commits the agent made itself count as changes. The batch CLI's exit code is not a per-task result; check each run in the [dashboard](./dashboard.md). Its outcome class tells you whether the agent, your setup, or DevIntern itself stopped the run; see [Why a run did not succeed](./dashboard.md#why-a-run-did-not-succeed).

## Reading logs and run data

- The dashboard's **Logs** tab shows recent worker output ([details](./dashboard.md)).
- The worker also writes `worker.stdout.log` and `worker.stderr.log` in the workspace home, including startup failures such as a failed license check and the output of its PR jobs (review feedback, `@mentions`, conflict resolution, CI fixes, auto-merge), each line prefixed with the job and PR. `devintern worker service logs` prints the service manager's log: the journal under systemd, `worker.launchd.log` under launchd.
- For scripts and sandboxed agents, `devintern worker runs`, `stats`, `automations`, `queue`, `status`, and `logs` print the same data; add `--json` for machine-readable output ([details](./dashboard.md#read-dashboard-data-from-the-command-line)).

## `worker status` says `unknown` inside a sandbox

This is expected. A command inside a PID-isolated sandbox cannot see a worker running outside it (and the reverse), so it reports `unknown` instead of `stopped`. `worker add` still works. Run `devintern worker status` from the worker's own environment to confirm it is running. If a sandbox reports `stopped` while the worker runs, restart the worker once after upgrading.
