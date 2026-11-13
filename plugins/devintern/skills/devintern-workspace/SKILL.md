---
name: devintern-workspace
description: Inspect or configure an existing DevIntern worker workspace, including repositories, teams, routing, recurring automations, estimations, Sentry monitors, pipelines, and runtime policies. Use for ongoing workspace.toml changes and reloads. First-time installation, account connections, and worker activation belong to devintern-setup; task dispatch and DevIntern PM setup are separate workflows.
---

# Configure a DevIntern workspace

Workspace/worker mode is the recommended ongoing DevIntern setup, including for a single repository. The worker serves registered repositories from `~/.devintern/workspace.toml` by default. Honor an explicit `devintern worker --workspace /path/to/workspace.toml` selection and `DEVINTERN_WORKSPACE_DIR` when present; check command help before assuming setup subcommands accept the same flags.

For first-time installation, credentials, source-control/tracker authorization, or bringing a worker online, use `devintern-setup` when available. Otherwise follow the [quick start](https://devintern.com/docs/code/quick-start) and [relay guide](https://devintern.com/docs/code/relay). A repository/team entry does not establish account access. Use `devintern-delegate` when available for one-off task dispatch. This skill can configure the requested behavior without assuming either companion skill is installed.

## Inspect before editing

Read the existing TOML and identify the intended repository remotes, tracker sources, and requested behavior. Inspect credential variable names or presence without printing secret values. Preserve unrelated settings, comments, and existing repository names: names are routing identifiers as well as directory names.

Use the [workspace guide](https://devintern.com/docs/code/workspaces) for the fields involved in the change. In the DevIntern source repository, read `docs/code/workspaces.md` and, for exact schema behavior, `packages/code/src/lib/workspace/config.ts`. Installed skills must not assume that the source checkout is available.

## Register additional repositories

Run this inside the checkout to register it with the existing workspace:

```bash
devintern worker add-repo
```

`add-repo` reads the origin remote, derives a unique filesystem-safe name, and detects the default branch. Re-adding the same repo is a no-op. It also imports `.devintern-code/.env`: absent keys are merged into the shared workspace `.env`, while conflicting values become repo-local `[repos.env]` entries. Inspect this effect when registering a repo; do not assume registration only changes the remote list. Existing repo `settings.json` continues to apply in task worktrees.

For custom workspace locations, inspect the installed setup commands' help. If they do not support the selected location, edit that workspace directly using the documented schema rather than accidentally scaffolding or registering in the default workspace.

## Choose task sources and routing

- A single-source workspace polls `[defaults].tracker` with `[defaults].task_query`. Use the selected tracker's query language. Do not invent a broad query merely to satisfy setup validation.
- `[[teams]]` creates isolated tracker sources and replaces the separate defaults poller. Each team needs its own query or the defaults fallback. A team dedicated to one codebase can set `repo` to a registered name; it cannot also have team-scoped routing rules.
- A team spanning repositories omits `repo` and uses applicable `[[routing.rules]]`. Criteria within a rule combine with AND; list values match any member. Matching rules must agree on one repo. Unmatched or ambiguous tasks are skipped, rather than routed by first match. Rules for other teams do not apply.
- A one-repo workspace needs no routing rules. Explicitly targeted ad-hoc tasks also need none. Do not create tracker configuration solely to dispatch one ad-hoc task; verify the installed worker's startup requirements before promising that a source-free workspace can run.
- For recurring agent work, read [Configure recurring automations](references/automations.md). It covers turning a request into a bounded prompt, selecting the repository and schedule, choosing PR behavior, and verifying activation. Automations do not require tracker tickets or tracker credentials.

## Configure additional worker behavior

Read the relevant guide rather than enabling these as incidental setup:

- **Scheduled estimation:** `[[estimations]]` contains a query, explicit enabled state, stable ID, and exactly one cron/interval schedule. It has no `repo` key and uses the workspace tracker; it is separate from recurring implementation prompts. Check tracker estimation support in the [estimation guide](https://devintern.com/docs/code/worker#scheduled-story-point-estimation).
- **Sentry monitors:** `[[error_monitors]]` maps each source to its owning repo and optional team with source-specific credentials and thresholds. Use `devintern-setup` when available for initial connection/token validation, or follow the [Sentry guide](https://devintern.com/docs/code/sentry-integration), including `worker connect sentry`. It is direct polling, not relay delivery.
- **Pipelines:** use repo `pipeline_file`, committed repo `settings.json`, workspace defaults `pipeline_file`, then the built-in pipeline in that precedence order. Definitions replace one another; step arrays are not merged. Relative workspace pipeline paths resolve against the workspace home. Validate referenced files using the [pipeline guide](https://devintern.com/docs/code/pipelines).
- **Operating policies:** task pickup windows, scheduled/disabled conflict resolution, and opt-in `ci_failure_fix` are independent controls. Pickup windows do not pause reviews, mentions, or recurring automations. Check the [worker guide](https://devintern.com/docs/code/worker) before changing a policy that starts agent runs or pushes commits. Preserve existing concurrency unless its change is requested.

## Keep environment scopes correct

The worker loads shared workspace `.env`, then repo `env_file`, then inline `[repos.env]` values. Relative repo `env_file` paths resolve against the workspace home. It does not automatically load the current checkout's `.devintern-code/.env` during workspace execution.

Teams layer their tracker credentials over shared workspace credentials using team `env_file` and inline `[teams.env]`. Task subprocesses retain repo settings and then receive the acquiring team's overrides, with `TASK_TRACKER` pinned to that team. Prefer owner-only secret files over adding token values to TOML; preserve `0600` on workspace secret files. Do not put credentials in summaries or committed examples.

## Apply and verify

Make the requested config change without starting new automation, changing concurrency, or enabling integrations unless that behavior is part of the user's request. Shared-host concurrency is opt-in through `[workspace.execution]` and `isolation = "best_effort_host"`; worktrees still share ports, processes, Docker, and caches.

Check TOML syntax and the relevant schema constraints before applying the change. Use an existing validation command if the installed CLI exposes one; do not invent `worker validate` or start the daemon merely to validate. For a source checkout, `parseWorkspaceConfig` provides schema validation without starting a worker. If no schema validator is available, state that validation covered syntax and documented constraints only.

For a running worker, distinguish:

- **Live changes:** repositories, routing, defaults/team queries, team `repo`, task args, pipeline references, automations, estimations, polling, retention, execution limits, conflict policy, and auto-update policy apply to subsequent work. Existing runs keep their original configuration.
- **Restart required:** shared tracker credentials, `[defaults].tracker`, team identity/tracker/credentials, error-monitor configuration, `[worker.schedule]`, dashboard settings and port. A reload containing startup-only changes is rejected in full.

A broken reload leaves the last valid configuration serving. A saved file alone is not proof of activation: inspect the worker's existing logs for successful reload or explain the required restart. Restart a service only when covered by the request; do not launch a second daemon alongside one already running. User-level systemd or launchd service setup is described in the [worker guide](https://devintern.com/docs/code/worker#running-as-a-service).

Summarize the config path, changed behavior, validation performed, and whether the running worker accepted the change or needs a restart. Name unresolved credentials or source configuration without exposing values.
