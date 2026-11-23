---
title: "Advanced Settings"
sidebarLabel: "Advanced Settings"
description: "Use when tuning DevIntern Code run limits, the auto-review loop, logging, telemetry, the output directory, prompt overrides, tracker status settings, or checking setup with devintern doctor."
section: "Automation Reference"
order: 0.3
dateModified: 2026-11-18
---

# Advanced Settings

Unless noted otherwise, set these in `.devintern-code/.env`, the workspace `.env`, or your shell. Every one is optional.

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

A project without a workspace can still use `.devintern-code/settings.json`, which uses the same fields in camelCase (`prStatus`, `inProgressStatus`, `todoStatus`, `storyPointsField`), grouped as `{ "jira": { "projects": { "PROJ": { ... } } } }`. That file is deprecated and prints a warning; when both exist, the workspace value wins for a project key.

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

`devintern init` runs some of these checks at the end. For the unattended worker, use [`devintern worker doctor`](./worker.md#checking-readiness-worker-doctor). If a failure looks like a DevIntern bug, run `devintern report` ([Reporting bugs](./reporting-bugs.md)).
