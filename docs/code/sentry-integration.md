---
title: "Sentry Auto-fixes"
sidebarLabel: "Sentry Auto-fixes"
description: "Turn Sentry error groups into repo-routed fixes from the workspace worker"
section: "Automation"
order: 4
dateModified: 2026-09-04
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
requires an auth token plus the organization and project slugs. Create an auth
token with `project:read` and `event:read` access.

Credential precedence, from lowest to highest, is: process environment,
workspace `.env`, repo `env_file`, `[repos.env]`, team credentials, the error
monitor's `env_file`, then `[error_monitors.env]`. This allows one worker to
serve teams and projects whose tokens differ.

## Behavior

An error is eligible when it meets `min_occurrences` (default `5`) and includes
a title plus a culprit, exception type, or filename. At most `max_per_tick`
(default `3`) errors are dispatched per poll. `poll_interval` defaults to
`[defaults].poll_interval`.

Handled issue IDs are stored in the workspace database under a source key that
includes the provider and configured source `id`. That prevents collisions
between Sentry projects. A failed fix is not automatically repeated; a run
deferred because the repo or agent capacity is busy is released and retried on
a later poll.

The provider contract is shared by all error monitors. Sentry is the first
adapter; adding Datadog support does not require another polling, deduplication,
or workspace-routing implementation.

`[[error_monitors]]` changes are validated by live reload but require a worker
restart because clients and credentials are startup-scoped.
