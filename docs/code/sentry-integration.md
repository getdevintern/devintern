---
title: "Sentry Auto-fixes"
sidebarLabel: "Sentry Auto-fixes"
description: "Turn Sentry error groups into repo-routed fixes from the workspace worker"
section: "Automation"
order: 4
dateModified: 2026-09-07
---

# Sentry Auto-fixes

The workspace worker can poll one or more Sentry projects for unresolved error
groups and run actionable errors through the normal fix pipeline: isolated
worktree, coding agent, tests, commit, and pull request.

## Configure projects in `workspace.toml`

Add one `[[error_monitors]]` entry per Sentry project. Every entry maps to the
repository that owns the code, so a multi-repo worker never has to guess where
an error should be fixed.

```toml
[[error_monitors]]
id = "api-production"
provider = "sentry"
repo = "backend"
team = "platform"             # optional; must match a [[teams]] name
organization = "acme"
project = "api"
query = "environment:production level:error"
poll_interval = 60
min_occurrences = 5
max_per_tick = 3
comment_on_action = true
env_file = "env/sentry-api.env"

[[error_monitors]]
id = "web-production"
provider = "sentry"
repo = "frontend"
organization = "acme"
project = "web"
env_file = "env/sentry-web.env"
```

`repo` may be omitted only when the workspace has exactly one `[[repos]]`
entry. In a multi-repo workspace it is required. `team` is optional and lets
the fix run inherit that team's environment and identity in addition to the
repository environment.

Each source is independent: use a separate `env_file` or
`[error_monitors.env]` table when projects need different credentials.

```bash
# env/sentry-api.env
SENTRY_AUTH_TOKEN=sntrys_...
```

```toml
[[error_monitors]]
id = "internal-api"
provider = "sentry"
repo = "backend"
organization = "acme"
project = "api"
base_url = "https://sentry.internal.example"
  [error_monitors.env]
  SENTRY_AUTH_TOKEN = "sntrys_..."
```

Do not put a Sentry DSN here. A DSN sends events into Sentry; polling issues
requires an auth token plus the organization and project slugs. With
`comment_on_action` omitted or `false` (the default), create an auth token with
`project:read` and `event:read` access.

When `comment_on_action = true`, DevIntern leaves a short comment after a
terminal successful or failed remediation run. It does not comment when a run
is deferred, resolve the issue, or change its status, assignment, or priority.
Comment delivery is best effort: a Sentry API rejection is logged as a warning
and never changes the run outcome or deduplication state.

Sentry's issue-comment endpoint is private and is not part of its documented
public API. In addition to the read scopes, use a personal token that
authenticates a Sentry user and grants **Issue & Event: Write** (`event:write`).
A read-only token must therefore be extended or replaced. Organization/internal
integration tokens may still be rejected because the endpoint requires an
authenticated user; leave the option disabled if your Sentry setup cannot use
a personal token. Sentry may change this private endpoint without notice.

Credential precedence, from lowest to highest, is: process environment,
workspace `.env`, repo `env_file`, `[repos.env]`, team credentials, the error
monitor's `env_file`, then `[error_monitors.env]`. This allows one worker to
serve teams and projects whose tokens differ.

## Behavior

An error is eligible when it meets `min_occurrences` (default `5`) and includes
a title plus a culprit, exception type, or filename. At most `max_per_tick`
(default `3`) errors are dispatched per poll. `poll_interval` defaults to
`[defaults].poll_interval`. Because the watcher has already applied those
actionability checks and supplied concrete runtime evidence, Sentry runs skip
the generic task feasibility assessment and proceed directly to implementation.

Handled issue IDs are stored in the workspace database under a source key that
includes the provider and configured source `id`. That prevents collisions
between Sentry projects. A failed fix is not automatically repeated; a run
deferred because the repo or agent capacity is busy is released and retried on
a later poll. Runs are recorded with an `error_monitor` origin rather than as
tracker tasks. If the worker restarts during a run, startup recovery marks the
interrupted run failed locally without trying to fetch its synthetic identifier
from Jira or another task tracker.

The provider contract is shared by all error monitors. Sentry is the first
adapter; adding Datadog support does not require another polling, deduplication,
or workspace-routing implementation.

`[[error_monitors]]` changes are validated by live reload but require a worker
restart because clients and credentials are startup-scoped.
