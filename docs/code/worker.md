---
title: "Worker Daemon"
sidebarLabel: "Worker"
description: "Use when running DevIntern as a long-running worker that picks up tracker tasks, handles PR reviews and CI failures, and runs as a service."
section: "Automation"
order: 2
dateModified: 2026-11-26
---

# Worker Daemon

`devintern worker` runs DevIntern as a long-running daemon on your own machine. It picks up work for every repository in your [workspace](./workspaces.md) and runs it locally. Your code, credentials, and agent runs stay on your machine.

## What the worker handles

- **Tracker tasks** that match your ready-tasks query ([polling mode](#polling-mode)).
- **Recurring automations**: prompts run on a schedule. See [Recurring Automations](./automations.md).
- **Follow-up on pull requests**: review feedback, merge conflicts, CI failures, auto-merge, and `@mentions`. See [PR Follow-up](./pr-follow-up.md).
- **Scheduled story-point estimation**. See [Story Points Estimation](./story-points-estimation.md#scheduled-estimation-with-the-worker).
- **Production errors** from Sentry. See [Sentry Auto-fixes](./sentry-integration.md).
- **Ad-hoc tasks** you enqueue with `devintern worker add`. See [Delegate Tasks to the Worker](./delegation.md). Withdraw one that has not started with `devintern worker cancel <taskKey>` (see [Cancel a pending task](./delegation.md#cancel-a-pending-task)).

When something does not get picked up, see [Worker Troubleshooting](./worker-troubleshooting.md).

## Quick start

```bash
devintern worker init
```

`worker init` reuses tracker config from `devintern init` (or asks for it), writes a one-repo workspace, validates the ready-tasks query, and asks about task pickup hours, conflict handling, and CI repair. It can add a Sentry project, offers sign-in for the [14-day free Worker Pilot](#worker-pilot-and-licenses) (no card required) if you have no license, pairs your repositories with the [relay](./relay.md), and offers to install the worker as a service. `--no-service` skips the service step. Tokens you paste are not shown on screen. Re-running it keeps your answers as defaults (press Enter to keep the current query), and it finishes a setup an earlier run stopped partway. It ends with the same checks as [`worker doctor`](#checking-readiness-worker-doctor) and tells you whether the worker is ready, whether signing in is the one step left, or what is still missing (for example an agent CLI). For Markdown tasks, a relative folder such as `./tasks` is saved as an absolute path, resolved from where you run the wizard. Without a terminal (coding agents, scripts, SSH), use [non-interactive setup](#non-interactive-setup).

For GitHub, install the central [DevIntern AI App](https://github.com/apps/devintern-ai/installations/new) on the workspace repositories. Its private key stays with DevIntern. Events reach your worker as reference-only envelopes, and your local `GITHUB_TOKEN` does the API work. After adding repositories, run `devintern worker connect` to pair them. Without the relay, polling still works; `@mention` handling then needs a [customer-owned GitHub App](./configuration.md#advanced-customer-owned-github-app).

## Non-interactive setup

Coding agents, provisioning scripts, and SSH sessions without a terminal can set up the worker with flags instead of prompts:

```bash
export JIRA_BASE_URL=https://acme.atlassian.net JIRA_EMAIL=bot@acme.com JIRA_API_TOKEN=...
devintern worker init --non-interactive --tracker jira \
  --task-query 'project = APP AND labels = devintern' --repo-from-cwd --json
```

Without a tracker account, point `MARKDOWN_TASKS_DIR` at an existing folder of [Markdown task files](./markdown-tasks.md): `MARKDOWN_TASKS_DIR=/abs/path/tasks devintern worker init --non-interactive --tracker markdown --task-query '<filter>' --repo-from-cwd`. A relative path is saved as an absolute path, resolved from the current directory.

It writes `[defaults].tracker` and `task_query`, registers the current repository, and saves the tracker credentials to the workspace `.env`. It then checks the credentials and runs the same checks as `worker doctor`: a dry run of the query (0 matches is a warning), repository access, license, agent harness, and sandbox. It never prompts, opens a browser, pairs the relay, installs a service, or starts the worker. Those stay as next steps in the output; the background service is one command, [`devintern worker service install`](#running-as-a-service). With `--sign-in <method>` it also starts the Worker Pilot sign-in when one is needed (see [Signing in without a terminal](#signing-in-without-a-terminal)).

| Flag                | Default            | What it does                                                                                          |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| `--non-interactive` | off                | Use flags instead of prompts                                                                           |
| `--tracker <id>`    | existing tracker   | `jira`, `linear`, `github`, `gitlab`, `azure-devops`, `asana`, `trello`, or `markdown`. Required for a new workspace |
| `--task-query <q>`  | existing query     | Ready-tasks query in the tracker's language. Required for a new workspace                            |
| `--repo-from-cwd`   | off                | Register the Git repository in the current directory, using its `origin` remote (any host), the same way `worker add-repo` does: its `.devintern-code/.env` is imported and a routing rule is seeded from its default project |
| `--env-file <path>` | none               | Read credentials from this file (must be mode `0600`) and save them to the workspace `.env`           |
| `--yes`             | off                | Update an existing `workspace.toml`: only the tracker, query, and repository named by the flags change |
| `--sign-in <method>` | off               | If nobody is signed in, start the sign-in without waiting: `github`, `google`, `x`, or your email address. The output carries the address to open |
| `--json`            | off                | Print one JSON document on stdout instead of text                                                     |

**Credentials.** Set the tracker's variables (for example `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`; see the tracker's integration page) and `GITHUB_TOKEN` in the environment, or put them in a file and pass `--env-file` (`KEY=value` lines; quotes and a leading `export` are allowed). Secrets are never accepted as flags. If the file is readable by others, the command refuses it; fix it with `chmod 600 <file>`. When something is missing, the error lists every missing flag and variable.

**Output.** The checks have the same verdicts as `worker doctor`:

| `result`          | Exit code | Meaning                                                                                       |
| ----------------- | --------- | --------------------------------------------------------------------------------------------- |
| `success`         | 0         | Every check passed or warned. The worker can start                                            |
| `action_required` | 2         | The configuration is saved and nothing is broken; nobody is signed in yet. Sign in to start the Worker Pilot, then run `worker doctor` |
| `failure`         | 1         | A check failed, or the input was invalid (`error` says why)                                   |

A signed-in account without an entitlement (for example a Pilot already used), or a `LICENSE_KEY` that does not validate, is a `failure`. With `--json`, stdout holds only this document. `version` changes only when the shape breaks; new `result` and `status` values can be added, so treat any value you do not know as not ready:

```json
{
  "schema": "devintern.worker-init",
  "version": 1,
  "result": "action_required",
  "workspaceDir": "/home/me/.devintern",
  "tracker": "jira",
  "taskQuery": "project = APP AND labels = devintern",
  "repo": { "name": "app", "remote": "git@github.com:acme/app.git", "added": true },
  "filesWritten": ["/home/me/.devintern/.env", "/home/me/.devintern/workspace.toml"],
  "checks": [{ "name": "tracker-auth", "label": "Tracker credentials", "status": "pass", "message": "JIRA accepted JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN" }],
  "nextSteps": [{ "id": "sign-in", "message": "Not started: sign in to begin your 14-day free Worker Pilot, no card required ...", "command": "devintern worker login github" }],
  "signIn": { "url": "https://...supabase.co/auth/v1/authorize?provider=github&...", "method": "github", "expiresAt": "2026-11-26T12:30:00.000Z", "complete": "devintern worker login --complete '<address>'" }
}
```

Each check `status` is `pass`, `warn`, `action`, `fail`, or `skipped`, and checks that are not `pass` carry a `hint`. If the command stops before the checks (bad input, or another `worker init` is changing the same workspace), `error` explains why and `checks` is empty. The files are written before the checks run, so after signing in you only run `worker doctor`, with no need to re-run init. `signIn` is present only when `--sign-in` started a sign-in. Next-step `id`s are `sign-in`, `add-repo`, `connect`, `start`, and `service`.

### Signing in without a terminal

The Worker Pilot belongs to your DevIntern account, so the worker host needs a sign-in even when nobody sits at it. Start it with `--no-wait`, open the printed address in any browser, and finish on the worker host:

```bash
devintern worker login github --no-wait          # or google, x, email you@company.com; add --json for a document
devintern worker login --complete 'http://127.0.0.1:17865/auth/callback?code=...'
```

After you sign in, the browser lands on a `127.0.0.1` page that does not load. That is expected: copy its full address into `--complete`. The address works once, only on the host that started the sign-in, and the pending sign-in expires after 30 minutes. `worker init --non-interactive --sign-in <method>` runs the first step for you. Run either command again to start over. With `--json`, `worker login` prints `{"result": "pending", "url", "method", "expiresAt", "complete"}`, `{"result": "signed_in", "user"}`, or `{"result": "failure", "error"}`.

To start a configured workspace by hand:

```bash
devintern worker                 # uses ~/.devintern/workspace.toml
devintern webhook serve          # advanced: repo-local GitHub webhook listener
```

## Checking readiness (`worker doctor`)

An idle healthy worker and an idle misconfigured one look the same. Run the doctor before starting, and after changing config, tokens, or trackers:

```bash
devintern worker doctor [--workspace <path>] [--offline] [--test-notifications]
```

It checks that `workspace.toml` parses, that there is something to acquire, tracker credentials per team, a dry run of each `task_query` (with match counts), access to each repository, your automation license, the agent harness and sandbox, and whether the dashboard port is free. Every failing row includes a fix hint. It exits 0 when ready and 1 when a check fails. When the only thing left is signing in, the license row shows 👉 `Not started: sign in to begin your 14-day free Worker Pilot, no card required` and it exits 2. An active Pilot shows its end date. `--offline` skips network checks. `--test-notifications` sends one test message through each [notification channel](notifications.md). The doctor never edits config or starts the worker. It is safe to run while the worker is up: it reports the running worker, and its dashboard on the port is not flagged as a conflict.

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

### Ticket dependencies

The worker picks up polled tickets in dependency order. Trackers with their own "blocked by" links need nothing turned on; Trello and markdown tasks list their blockers on a `Depends on:` line in the description:

| Tracker        | Blockers it reads                                                                                                              | Blocker counts as done                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Jira           | "Blocks" issue links where the ticket "is blocked by" another issue                                                            | "Done" status category                          |
| Linear         | "Blocked by" relations                                                                                                         | Completed or canceled                           |
| GitHub Issues  | Issue dependencies ("Blocked by"). If the repository or account does not have them, tickets run as before                     | Closed                                          |
| GitLab Issues  | "Is blocked by" linked items. These need GitLab Premium or Ultimate; on Free, tickets run as before                           | Closed                                          |
| Azure DevOps   | Predecessor links                                                                                                              | A state in the Completed or Removed category    |
| Asana          | Task dependencies ("Blocked by"). If the workspace plan does not have them, tasks run as before                               | Marked complete                                 |
| Trello         | `Depends on:` line in the card description, listing card links or short links (`Depends on: https://trello.com/c/Ab12Cd34`) | Archived, or in a list named Done, Complete(d), Closed, or Cancel(l)ed |
| Markdown files | `Depends on:` line in the task body, listing task keys (file names without `.md`, such as `Depends on: api-schema, task-12`)  | `status:` is done, complete(d), closed, or cancel(l)ed |

On Trello and markdown, separate keys with commas or spaces. Text after a dash or parenthesis is ignored, and words that are not shaped like a key are skipped: a Trello short link needs a digit (write a short link without one as a card URL), and a markdown key needs a hyphen or digit. A Trello key that matches no card keeps the ticket waiting with `not found` as the reason, and the worker logs a warning. On markdown, a word with no task file is ignored unless it looks like a ticket key (`local-add-login`, `task-12`), which waits as `not found`.

A blocked ticket is held back without being started, transitioned, or commented on. The worker checks it again on the next poll, then less often while it keeps waiting (up to every 15 minutes). Editing the ticket triggers a check right away:

- **A blocker the worker implemented** follows the same rules as [dependent ad-hoc tasks](./delegation-dependencies.md#modes-merged-and-stacked). When `dependency_mode` is not set, tickets in GitHub repos are stacked and tickets in other repos (GitLab, Bitbucket) wait for the merge. In `merged` mode the ticket waits until the blocker's PR merges. In `stacked` mode it starts on the blocker's branch once the blocker's run succeeded, and its PR targets that branch.
- **A blocker the worker never handled** counts only once the tracker marks it done (see the table above).
- **A blocker whose run failed, or whose PR was closed without merging,** keeps the ticket blocked. Marking the blocker done in the tracker, or re-running it, releases the ticket.

GitHub and GitLab issue numbers and markdown keys belong to one team's repository, project, or tasks folder, so only that team's runs count as the worker having handled the blocker.

Set the mode with `[defaults].dependency_mode`, or per team with `dependency_mode` in a [`[[teams]]`](./workspaces.md#multiple-teams-and-tracker-boards) entry. A blocker can only be stacked on within the same repository; a blocker in another repo is waited on until its PR merges.

`devintern worker queue` and the dashboard's Queued list show each held-back ticket with its reason, for example `waiting: PROJ-12 not done (In Progress)` or `waiting: PROJ-12 PR #7 not merged`.

A dashboard retry follows the same rules. A stacked ticket is retried on its blocker's branch. Retrying a ticket that is still held back does not start it: the retry is marked failed with the reason, and the worker starts the ticket once its blockers are satisfied.

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

## Notifications

The worker records notification rows in `queue.db` for work that needs attention — a task escalated, retries ran out, an automation broke, a source stopped being readable — and for changes outside itself: PRs it opened or auto-merged, and delegated work with its child progress. Emits for the same event fold into one row, and a later success resolves the row it belongs to.

Notifications are pruned after 30 days by default. A startup sweep and an hourly sweep delete resolved rows past the window, plus the informational rows that are never resolved (PRs opened or auto-merged and delegated-work rollups) once they age out, so a long-lived workspace's database stays bounded. Open rows that still need a human are kept until they are resolved. Set `WORKER_NOTIFICATION_RETENTION_DAYS` to change the window; `0` deletes aged-out rows at the next sweep.

## Options

The daemon takes few flags. Durable settings live in [`workspace.toml`](./workspaces.md#the-workspace-file).

| Option               | Description                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `--workspace <path>` | Use this `workspace.toml` (default `~/.devintern/workspace.toml`, or `DEVINTERN_WORKSPACE_DIR`) |
| `-v, --verbose`      | Verbose logging                                                                                |
| `--no-update`        | Skip the self-update check for this run                                                        |

The worker serves the [dashboard](./dashboard.md) on `http://localhost:4400`. Set `[workspace].dashboard = false` to disable it or `[workspace].dashboard_port` to move it. `devintern dashboard` also works while the worker is stopped.

## Running as a service

`devintern worker service` installs and runs the worker in the background: a systemd user unit in `~/.config/systemd/user/` on Linux, a launchd agent in `~/Library/LaunchAgents/` on macOS. It needs no terminal, so coding agents, provisioning scripts, and `ssh host cmd` can use it. The `worker init` wizard offers the same install at its last step.

```bash
devintern worker service install      # check readiness, install, start, wait until the worker runs
devintern worker service status       # service and worker state, and why the last start failed
```

| Action      | What it does                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `install`   | Runs the [`worker doctor`](#checking-readiness-worker-doctor) checks, installs or updates the service, starts it, and waits until the worker is running |
| `start`     | Starts the installed service and waits until the worker is running                                       |
| `stop`      | Stops the service. The worker finishes its graceful shutdown and exits cleanly                           |
| `restart`   | Restarts the service, also after a failure, and waits until the worker is running                        |
| `status`    | Shows the service state (`running`, `starting`, `restarting`, `failed`, `stopped`, `not_installed`) and the last start failure |
| `uninstall` | Stops the service and removes the DevIntern-managed definition                                          |
| `logs`      | Prints the service manager's log (`-n <lines>`, default 100). `devintern worker logs` shows the worker's own log |

| Option             | Default | What it does                                                                     |
| ------------------ | ------- | -------------------------------------------------------------------------------- |
| `--json`           | off     | Print one JSON document (`schema` `devintern.worker-service`, `version` 1) instead of text |
| `--force`          | off     | `install` only: install even when readiness checks fail                          |
| `--wait <seconds>` | 45      | How long `install`, `start`, and `restart` wait for the worker. `0` skips the wait |

`install` refuses when the worker could not start yet: it lists the failing checks, or says signing in is the one step left. After you fix them, run it again. Once the service is started, the command waits for the worker itself and reports one of three outcomes: running (with the dashboard address), failed (with the worker's last log lines and the fix), or still starting after `--wait`. Exit codes: `0` done, `1` failed, `2` install refused because only signing in is left, `3` still starting.

Every action is safe to repeat. `install` updates a DevIntern-managed service in place and never overwrites a hand-written one. Both definitions record your current `PATH` (and `DEVINTERN_WORKSPACE_DIR`, for a workspace outside `~/.devintern`). If a step fails, nothing is left half-installed. Where there is no systemd user session (most containers, WSL without systemd), there is no service; run `devintern worker` in the foreground, for example inside `tmux`.

On Linux, `install` enables lingering for your user so the worker starts at boot and keeps running after you log out. Where that needs root, it prints the command to run (`sudo loginctl enable-linger <user>`).

A worker that cannot start because of its setup (no license, nobody signed in, invalid `workspace.toml`) is not restarted every 30 seconds: the service stops with status `failed` and the reason is in the worker log and in `worker service status`. Fix the problem, then run `devintern worker service restart`. Other crashes are restarted after 30 seconds. See [The service keeps failing](./worker-troubleshooting.md#the-service-keeps-failing).

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

The **Worker Pilot** gives a signed-in user 14 days of unattended use with no task-count limit and no card required. The 14 days start when the worker first starts with a valid workspace, not when you sign in. Run `devintern worker login github` (or `google`, `x`, `email you@company.com`), then `devintern worker`. On a host without a terminal, see [Signing in without a terminal](#signing-in-without-a-terminal). `worker doctor` shows the Pilot's end date.

After the pilot, the worker needs an automation license (Supporter, Team, or Business). A paid `LICENSE_KEY` does not need a login. If access expires while running, in-flight work finishes and new pickup pauses until a license is added. Interactive CLI use stays free.
