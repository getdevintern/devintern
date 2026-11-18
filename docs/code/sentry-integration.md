---
title: "Sentry Auto-fixes"
sidebarLabel: "Sentry Auto-fixes"
description: "Turn Sentry error groups into repo-routed fixes from the workspace worker"
section: "Automation Reference"
order: 3
dateModified: 2026-11-18
---

# Sentry Auto-fixes

The workspace [worker](./worker.md) can poll Sentry projects for unresolved error groups and run actionable errors through the normal fix pipeline: isolated worktree, coding agent, tests, commit, and pull request. Sentry is an extra work source; the worker still needs its normal tracker and ready-tasks query.

## Prerequisites

- A running workspace worker (`devintern worker init`)
- A Sentry auth token with `event:write` access, plus the organization and project slugs. A DSN does not work: it only sends events into Sentry.

## Setup

`devintern worker init` has an optional Sentry step for the first project. It validates the token and project, writes an enabled monitor pinned to the initial repository, and stores the token in an owner-only file. To add a project later:

```bash
devintern worker connect sentry
devintern worker connect sentry --repo backend   # pick the repository explicitly
```

For manual setup, add one `[[error_monitors]]` entry per Sentry project in `workspace.toml`:

```toml
[[error_monitors]]
id = "api-production"
provider = "sentry"
repo = "backend"
organization = "acme"
project = "api"
query = "environment:production level:error"
env_file = "env/sentry-api.env"   # contains SENTRY_AUTH_TOKEN=sntrys_...
```

| Key                 | Default                       | Description                                                                         |
| ------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `id`                | (required)                    | Unique source id; handled issues are tracked per id                                 |
| `provider`          | (required)                    | `sentry`                                                                            |
| `enabled`           | `true`                        | Set `false` to keep the entry without polling it                                    |
| `repo`              | only repo                     | Repository that owns the code; required when the workspace has several `[[repos]]`  |
| `team`              | —                             | A `[[teams]]` name whose environment and identity the fix run inherits               |
| `organization`      | (required)                    | Sentry organization slug                                                            |
| `project`           | (required)                    | Sentry project slug                                                                 |
| `query`             | —                             | Sentry issue search filter                                                          |
| `base_url`          | `https://sentry.io`           | Self-hosted Sentry URL                                                              |
| `poll_interval`     | `[defaults].poll_interval`    | Seconds between polls                                                               |
| `min_occurrences`   | `5`                           | Minimum event count before an issue is eligible                                     |
| `max_per_tick`      | `3`                           | Maximum issues dispatched per poll                                                  |
| `comment_on_action` | `false`                       | Comment on the Sentry issue when a fix run succeeds or fails (best effort)          |
| `env_file` / `[error_monitors.env]` | —             | Credentials for this source, such as `SENTRY_AUTH_TOKEN`                            |

Credentials resolve from lowest to highest precedence: process environment, workspace `.env`, repo `env_file`, `[repos.env]`, team credentials, the monitor's `env_file`, then `[error_monitors.env]`. Projects with different tokens can share one worker.

Changes to `[[error_monitors]]` are validated on live reload but need a worker restart to take effect.

## Behavior

- An issue is eligible when it reaches `min_occurrences` and has a title plus a culprit, exception type, or filename. Sentry runs skip the feasibility check and go straight to implementation.
- A run that concludes no code change is needed (already fixed, not reproducible, environment-specific) is a successful no-op: no branch, no PR, and the Sentry issue stays unresolved.
- A failed fix is not retried automatically. A run deferred because the repository or agent is busy is retried on a later poll.
- Issues below the threshold are skipped quietly; run the worker with `--verbose` to see why.
- Runs appear in the dashboard with an `error_monitor` origin rather than as tracker tasks.

## Source health in the dashboard

A Sentry read that fails is reported as `auth-failed` (rejected token), `rate-limited` (HTTP 429), or `unreadable` (network error, timeout, or bad response); it is never treated as "no new errors". Nothing is skipped: the next poll retries from the same point. When Sentry sends `Retry-After`, the worker waits out that window, capped at ten poll intervals or one hour, whichever is longer, even across restarts. Repeated failures are logged once and then as periodic reminders.

When any source is unhealthy, the [dashboard](./dashboard.md) header shows a warning such as **1 source needs attention**. It links to **Source health** under **Automations**, which lists each source's status, last successful read, consecutive failures, last error, and next retry time. `GET /api/sources` returns the same list as JSON.

## Troubleshooting

| Symptom                                       | Fix                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Error monitor "<id>" is missing SENTRY_AUTH_TOKEN` | Add the token to the monitor's `env_file`, `[error_monitors.env]`, or the workspace `.env`. |
| Source shows `auth-failed`                    | The token was rejected; create a new auth token with `event:write` and restart the worker. |
| Errors never get picked up                    | Check `min_occurrences` and `query`; run the worker with `--verbose` to see skipped issues. |
| Config change has no effect                   | Restart the worker; error monitors are loaded at startup.                                 |
