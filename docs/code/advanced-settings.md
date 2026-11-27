---
title: "Advanced Settings"
sidebarLabel: "Advanced Settings"
description: "Use when tuning DevIntern Code run limits, the auto-review loop, logging, telemetry, the output directory, prompt overrides, tracker status settings, or checking setup with devintern doctor."
section: "Automation Reference"
order: 0.3
dateModified: 2026-11-27
---

# Advanced Settings

Unless noted otherwise, set these in the repository's env file (`~/.devintern/env/<repo>.env`), the workspace `.env`, or your shell. Every one is optional.

## Execution limits

| Variable / flag                  | Default | Effect                                                                                                                   |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `AGENT_HARNESS_TIMEOUT_MINUTES`  | `60`    | Maximum wall-clock time for one agent run                                                                                 |
| `--max-turns`                    | `500`   | Turn limit for implementation runs (the clarity check always uses 10)                                                     |
| `CLAUDE_MAX_TURNS`               | `500`   | Turn limit for PR follow-up runs (`address-review`, `resolve-conflicts`, auto-merge review, webhook reviews), which don't accept `--max-turns` |
| `HOOK_RETRIES`                   | `10`    | Attempts to fix failing git hooks in `address-review` and webhook review jobs                                             |
| `AGENT_SPAWN_ENOENT_RETRIES`     | `5`     | Retries when the agent CLI is briefly missing, for example while it updates itself                                        |
| `AGENT_SPAWN_ENOENT_BACKOFF_MS`  | `1000`  | Delay before the first of those retries, doubling each time                                                               |
| `--agent-path`                   |         | Agent executable to use for this run (same as `AGENT_CLI_PATH`)                                                          |
| `--skip-clarity-check`           |         | Skip the feasibility check before implementation                                                                          |

After fetching a task, DevIntern always runs the full workflow (clarity check, then agent, then commit/PR). There is no fetch-only mode.

### Job memory limits

Jobs the worker runs as subprocesses (`task`, `address-review`, `resolve-conflicts`, CI fixes, auto-merge, scheduled automations) run in their own memory-limited systemd scope, so one runaway agent fails its job instead of taking the daemon (and every other job) down with it. Set the cap in `workspace.toml`:

```toml
[defaults]
job_memory_max = "8GB"   # default: 50% of the memory budget, split across max_concurrency jobs
```

| Value            | Effect                                                        |
| ---------------- | ------------------------------------------------------------- |
| `"8GB"`, `"512MB"` | Absolute cap (binary units; `8GB` means 8 GiB)               |
| `"50%"`          | Percentage of the memory budget (physical RAM, or a smaller container cgroup limit) |
| `"off"`          | No per-job limit                                              |

The cap covers the job's whole process tree: the job process, its agent, and any tests, builds, or servers the agent starts. Where the host supports it, swap is also disabled inside the job, so reaching the cap ends the job instead of letting it thrash. A job that hits the cap is recorded as `agent exceeded the job memory limit (8 GB)`. A run that exits successfully is kept successful even if a descendant was killed and the agent handled it. If the killed process is the job process itself, there is nothing left to record the reason and the run is recorded as interrupted or orphaned instead. Agents run under a Docker sandbox are outside this cgroup and follow that sandbox's own memory settings instead.

The limit is per job, not a total for the worker. When `max_concurrency` is greater than 1, the default is divided by it so all jobs together stay near 50% of the budget. Set `job_memory_max = "off"` to keep the previous unlimited behavior.

The setting comes from `workspace.toml`, so manual runs and checkouts without a workspace config get no cap even though the default percentage applies to worker jobs. The worker logs the effective cap (or why it is disabled) at startup, and `devintern worker doctor` lists it. Existing workspaces get the default cap after upgrading: 50% of the memory budget divided by `max_concurrency` (for example 2 GB per job on a 16 GB host with `max_concurrency = 4`). If builds or test suites that used to pass start failing on the limit, raise `job_memory_max` or set it to `"off"` to keep the previous unlimited behavior.

Review agents that `devintern webhook serve` runs in-process are not subprocess jobs, so they run in the server's own cgroup and are not covered by this cap.

This needs Linux with a running systemd user manager (`systemd-run --user --scope`). On macOS, in containers without systemd, and on hosts without a user manager, jobs run without the limit; DevIntern re-checks the manager while the worker runs, so one that disappears falls back to unlimited jobs instead of failing them. If the manager cannot start a job's scope at spawn time, that job runs unwrapped for the attempt and the next job re-checks the manager instead of failing until the cache expires. Hosts whose systemd cannot disable swap get a RAM-only cap instead of no cap. Any systemd release with a user manager works, including Debian 12 and RHEL 9 (systemd 252). `devintern worker service install` writes `OOMPolicy=stop` on the unit, so a unit-level OOM stops the service cleanly rather than killing an unrelated process; the daemon itself is not capped, so it is the last thing to be killed. Stopping or restarting the worker lets in-flight jobs drain; jobs still running after the grace period are stopped. If the worker is killed or crashes, its leftover jobs are stopped when the service stops and again when the worker next starts.

In a container, percentages and the default resolve against the smaller of physical RAM and the container's cgroup memory limit, so a job cannot exceed the container's cap.

## Auto-review loop

With `--create-pr --auto-review`, DevIntern reviews its own PR, applies fixes, and reviews again. It stops when the review approves, when no important issues remain, or when it reaches the iteration cap. Auto-review doesn't block publishing: if the review step errors out, the PR is still pushed.

| Setting                                         | Default | Notes                                                                 |
| ----------------------------------------------- | ------- | --------------------------------------------------------------------- |
| `AUTO_REVIEW_ITERATIONS` / `--auto-review-iterations N` | `2`     | Maximum review–fix cycles, minimum `1`. The flag overrides the variable |

The same setting covers CLI runs, workers, and the webhook server. Workers can also pass `--auto-review-iterations N` in `[defaults].worker_task_args`. The old `WEBHOOK_AUTO_REVIEW_MAX_ITERATIONS` still works but prints a deprecation warning. The number of iterations each run used is saved in the run record and in `auto-review-summary.json`.

## Logging and diagnostics

| Variable                                | Default | Effect                                                                    |
| --------------------------------------- | ------- | ------------------------------------------------------------------------- |
| `DEVINTERN_VERBOSE`                     | unset   | `1` logs every API call, response, and retry to the console               |
| `DEVINTERN_HARNESS_LOGS`                | on      | `0` turns off agent run transcripts                                       |
| `DEVINTERN_HARNESS_LOG_MAX_FILE_MB`     | `10`    | A transcript is truncated at this size                                    |
| `DEVINTERN_HARNESS_LOG_RETENTION_DAYS`  | `30`    | Transcripts older than this are deleted                                   |
| `DEVINTERN_HARNESS_LOG_MAX_FILES`       | `500`   | Maximum number of transcripts kept                                        |
| `DEVINTERN_HARNESS_LOG_MAX_TOTAL_MB`    | `256`   | Maximum total size of all transcripts                                     |

### Harness run logs

Each agent run (implementation, clarity checks, estimation, hook fixes, auto-review, PR review addressing, conflict resolution, webhook reviews) writes a transcript to `~/.devintern/logs/harness/`, or under `DEVINTERN_WORKSPACE_DIR` if you set it. Each file records the task, harness, command, the full output, the exit code, and whether a turn or usage limit was hit. A run that fails or times out still leaves a log.

You can open a run's logs from its page in the [dashboard](./dashboard.md), or read them as JSON from `GET /api/runs/:id/harness-logs` and `GET /api/runs/:id/harness-logs/:name`.

> Transcripts are saved unredacted. The dashboard hides values that look like credentials, but that is best-effort pattern matching. Treat transcripts as sensitive, and set `DEVINTERN_HARNESS_LOGS=0` where they may contain secrets.

## Output directory

```bash
DEVINTERN_OUTPUT_DIR=./devintern-output   # default: /tmp/devintern-tasks
```

Each task gets `{output-dir}/{task-key}/` containing the formatted task (`task-details.md`), the clarity check result, the implementation summary (`implementation-summary.md`, or `implementation-summary-incomplete.md` on failure), verify and auto-review results, and any downloaded attachments. These are debug files and safe to delete. Retry state and run history live in `~/.devintern/state/queue.db` instead.

Files you want to keep and show in the dashboard are registered separately as run artifacts; see [Pipeline artifacts](./artifacts.md).

## Error reporting and analytics

**Error reporting.** By default, the CLI sends crashes and failed runs (agent, tracker, PR, commit, estimation, and webhook errors) to DevIntern's Sentry project. Reports include identifiers such as the task key, tracker type, and stage. They never include task content, code, `.env` contents, or credentials, and anything that looks like a token is removed. To opt out, set `SENTRY_DISABLED=1`.

**Anonymous usage analytics.** The CLI sends anonymous events to PostHog: CLI version, OS, whether it runs in CI, tracker type, run mode, feature flags, and outcome categories for setup, `doctor`, login, and the worker. It never sends task content, code, repository names, file paths, or credentials. A random ID is created once and stored in `~/.devintern/telemetry.json`. To opt out, use either:

| Opt-out                                                    | What is sent                                    |
| ---------------------------------------------------------- | ----------------------------------------------- |
| `DEVINTERN_TELEMETRY_DISABLED=1`                           | Nothing                                         |
| `{ "analytics": { "enabled": false } }` in `~/.devintern/settings.json` | One anonymous `analytics_opt_out` event, then nothing |

See [devintern.com/privacy](https://devintern.com/privacy/).

## Prompt overrides

The prompts DevIntern sends to the agent are Markdown files bundled with the CLI:

| Prompt          | Used for                                    |
| --------------- | ------------------------------------------- |
| `clarity.md`    | Feasibility / clarity check before implementing |
| `estimation.md` | Story-point estimation                      |
| `review.md`     | Auto-review of the PR                       |
| `fix.md`        | Addressing review feedback                  |

To override `clarity.md` or `estimation.md`, put a file with the same name in `~/.devintern/prompts/`. To override it for one repository only, use `~/.devintern/prompts/<repo>/`, where `<repo>` is the `name` of its `[[repos]]` entry in `workspace.toml`. A directory named by `DEVINTERN_PROMPTS_DIR` takes precedence over both. Keep the frontmatter (`name`, `description`, `placeholders`, `requiredSections`) and the `{{placeholder}}` tokens from the bundled file; a placeholder with no value fails the run.

`review.md` and `fix.md` always come from the bundled copy, because their verdicts decide whether a PR is approved.

Overrides in a project's `.devintern-code/prompts/` are no longer read; DevIntern prints a warning when it finds one. Move the files to `~/.devintern/prompts/`.

## Tracker status settings

Status mappings and the story-points field are set per tracker project. With a workspace, put them in `~/.devintern/workspace.toml`:

```toml
[trackers.jira.projects.PROJ]
pr_status = "In Review"
in_progress_status = "In Progress"
todo_status = "To Do"
story_points_field = "customfield_10016"

[trackers.linear.projects.ENG]
pr_status = "In Review"
```

| Key                  | Effect                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pr_status`          | Status, state, or label to set after the PR is created. This also moves the ticket out of sweep queries ([details](./worker-troubleshooting.md#tickets-already-actioned-after-a-pr)) |
| `in_progress_status` | Status to set when work starts                                                                                      |
| `todo_status`        | Status to restore if implementation fails                                                                           |
| `story_points_field` | Custom field for story points. Found automatically if omitted                                                        |

Trackers are `jira`, `linear`, `trello`, `azure-devops`, `asana`, `github`, `gitlab`, and `markdown`. Each uses its own project key (Jira project, Linear team key, Trello board ID, `owner/repo` for GitHub, and so on); see that tracker's integration guide. Quote keys that contain spaces or slashes, for example `[trackers.github.projects."acme/web"]`. Only the section for the active `TASK_TRACKER` is used.

A repository's `.devintern-code/settings.json` is no longer read. Its tracker sections are copied to `[trackers]` automatically the first time DevIntern runs there (or when the worker starts).

To add verification or custom steps, use a workspace `pipeline_file`; see [Customizing the Task Pipeline](./pipelines.md).

## Readiness check

`devintern doctor` checks your setup on one screen:

- Bun and Git
- **Agent CLI**: every entry in `AGENT_HARNESS`, checked the same way the worker checks at startup. For each entry it shows the resolved path, the sandbox that will be used, the model, and whether it is ready. It flags mise shims under a sandbox and nono runs with no pack.
- Tracker credentials for your `TASK_TRACKER`
- DevIntern sign-in, and the license when you're signed in (needed only for unattended automation)

Every failure comes with a suggested fix. The probes only run `<cli> --version` and change nothing.

| Exit code | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| `0`       | Ready (warnings, such as a missing fallback harness or license, are shown but don't fail)       |
| `1`       | Not ready: a check failed, for example no harness in the chain can run or the primary can't start |
| `2`       | Only with `--strict`: warnings but no failures, for CI that requires a fully ready setup       |

`devintern init` runs some of these checks at the end. In a checkout of a worker repository, `devintern doctor` runs the [`devintern worker doctor`](./worker.md#checking-readiness-worker-doctor) checks instead and uses their exit codes (`2` also means only sign-in is left); `--strict` still exits `2` on warnings. If a failure looks like a DevIntern bug, run `devintern report` ([Reporting bugs](./reporting-bugs.md)).
