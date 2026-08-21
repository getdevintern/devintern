# Sentry Integration

`devintern sentry` watches a Sentry organization or project for new errors and
creates bugfixes automatically. Each new, valid error group is rendered as a
markdown bugfix task and run through the standard pipeline (branch, agent,
commit, PR with `--create-pr` semantics from `WORKER_TASK_ARGS`).

## Setup

Add to `.devintern-code/.env`:

```bash
SENTRY_AUTH_TOKEN=sntrys_...   # Sentry auth token (User auth token)
SENTRY_ORG=my-org              # Organization slug
SENTRY_PROJECT=my-project      # Optional: scope the watcher to one project
# SENTRY_BASE_URL=https://sentry.example.com  # Self-hosted Sentry only
```

Create an auth token in Sentry under **Settings → Auth Tokens** with
`project:read` and `event:read` scopes.

## Usage

```bash
# Watch continuously (default: every 60s)
devintern sentry

# Watch one project, poll every 2 minutes, require at least 10 events
devintern sentry --project my-project --interval 120 --min-events 10

# Single tick for cron-driven setups
devintern sentry --once

# Narrow what counts as a new error with Sentry search terms
devintern sentry --query "environment:production level:error"
```

## Worker mode

The watcher also runs inside the long-running worker daemon. With
`SENTRY_AUTH_TOKEN` and `SENTRY_ORG` in `.devintern-code/.env`,
`devintern worker` automatically registers the Sentry acquirer alongside its
other event sources — no extra flags needed:

```bash
devintern worker --query "status = 'To Do'"   # tracker polling + Sentry watching
```

Worker-mode env vars: `SENTRY_PROJECT`, `SENTRY_BASE_URL`, `SENTRY_QUERY`,
`SENTRY_POLL_INTERVAL` (falls back to the worker's `--interval`),
`SENTRY_MIN_EVENTS`, and `SENTRY_MAX_PER_TICK`. Both modes share
`.devintern-code/queue.db`, so an error group handled by the worker is never
re-processed by a standalone `devintern sentry` run (or vice versa).

## Validity gate

An error group is only turned into a bugfix when it passes all checks:

1. **Minimum event count** — at least `--min-events` occurrences (default 5),
   so one-off blips are ignored.
2. **Actionable metadata** — the issue has a title plus a culprit or exception
   type/file so the agent can locate the failure.
3. **Injected validator hook** — reserved for custom/agent-based assessment.
4. **Pipeline clarity check** — the bugfix task still goes through the normal
   feasibility assessment before any code is written.

## Deduplication

Every error group is handled **at most once**, ever. Handled group ids are
persisted in `.devintern-code/queue.db` (`processed_events`, source `sentry`)
and marked *before* execution, so restarts, overlapping ticks, and failing runs
never re-trigger the same error. A group re-enters only if Sentry assigns it a
new issue id.

## Options

| Option                | Env var               | Default            |
| --------------------- | --------------------- | ------------------ |
| `--token <token>`     | `SENTRY_AUTH_TOKEN`   | —                  |
| `--org <slug>`        | `SENTRY_ORG`          | —                  |
| `--project <slug>`    | `SENTRY_PROJECT`      | whole organization |
| `--base-url <url>`    | `SENTRY_BASE_URL`     | `https://sentry.io`|
| `--interval <secs>`   | `SENTRY_POLL_INTERVAL`| `60`               |
| `--min-events <n>`    | `SENTRY_MIN_EVENTS`   | `5`                |
| `--max-per-tick <n>`  | —                     | `3`                |
| `--query <terms>`     | —                     | —                  |
| `--once`              | —                     | —                  |

Like the worker, `devintern sentry` is unattended automation and requires the
automation entitlement.
