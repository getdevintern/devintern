# `devintern worker` daemon e2e coverage

Scope: the worker daemon loop: injected-task drain, generic tracker polling, scheduled automations and estimations, working windows, concurrency, orphan recovery, team routing, review/CI/conflict jobs, native service, and auto-update. Tracker-specific polling lives in the tracker files; relay, dashboard, harness failover, and Sentry have their own files.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Daemon: injected task drain, branch/PR, run record, worktree cleanup, graceful stop

- Surface: `devintern worker` surface
- Status: `default` / `live`
- Evidence: `tests/local/worker.test.ts`, `tests/code/gitlab-worker.test.ts`
- Missing: —
- Last reviewed: 2026-11-17

### Tracker polling and actioned deduplication

- Surface: `devintern worker` surface
- Status: `live`
- Evidence: GitLab worker suite
- Missing: GitHub worker path (Jira, Trello, Azure DevOps, Linear, and Asana: see the tracker files).
- Last reviewed: 2026-11-17

### Scheduled `[[automations]]`: schedule, no-op, branch/push policy, hot reload

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-automations.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: PR creation on a live code host (bare remote exposes no platform).
- Last reviewed: 2026-11-17

### Scheduled `[[estimations]]`

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-scheduled-estimation.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Live Jira project field behavior.
- Last reviewed: 2026-11-17

### Working windows / quiet hours

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-working-windows.test.ts`
- Missing: Additional timezone and daylight-saving scenarios.
- Last reviewed: 2026-11-17

### Workspace and per-repo concurrency

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-concurrency.test.ts`
- Missing: More than two repositories and mixed work sources.
- Last reviewed: 2026-11-17

### Orphan recovery after a crash

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-orphan-recovery.test.ts`
- Missing: Additional crash timing scenarios.
- Last reviewed: 2026-11-17

### Review polling, CI repair, conflict resolution

- Surface: `devintern worker` surface
- Status: `live`
- Evidence: GitLab worker suite
- Missing: GitHub parity and scheduled/manual modes.
- Last reviewed: 2026-11-17

### Native service install/uninstall

- Surface: `devintern worker` surface
- Status: `gap`
- Evidence: —
- Missing: systemd/launchd path without touching the host service manager.
- Last reviewed: 2026-11-17

### Auto-update

- Surface: `devintern worker` surface
- Status: `gap`
- Evidence: —
- Missing: Disabled in tests; simulate an available update safely.
- Last reviewed: 2026-11-17

### Team routing, `env_file`, per-repo env

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-team-routing.test.ts`
- Missing: Additional team and repo combinations.
- Last reviewed: 2026-11-17

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 13: Quiet hours, concurrency, and orphan recovery on a deterministic local workspace. Scheduled automations are implemented by `tests/local/worker-automations.test.ts`. Scheduled estimations are implemented by `tests/local/worker-scheduled-estimation.test.ts`.
- Priority 18: Native service install and auto-update in a sandboxed user-scope fixture.

## Test notes

### Scheduled workspace automations

`tests/local/worker-automations.test.ts` starts one real `devintern worker`
against a throwaway workspace whose `[[automations]]` entries are all scheduled
on the next cron minute (`cron = "* * * * *"`). It seeds a local bare Git remote
from `fixtures/simple-project`, uses the deterministic fake agent, and reads the
queue database and the bare remote instead of parsing CLI stdout. The matrix
covers:

- `open_pr = true`: the run is `scheduled`, records a branch, and the branch on
  the bare remote changes exactly `src/greeting.ts` in one commit. PR creation
  itself is not covered here: the bare remote has no detectable code-host
  platform, so the run succeeds with `pr_url` null and the code-host suites own
  that path. A second workspace in the same file omits `--create-pr` from its
  defaults, proving the automation's own `open_pr` opt-in still pushes a branch.
- `open_pr = false`: the agent still runs (each invocation is attributed to its
  automation via `DEVINTERN_AUTOMATION_ID`), but the per-automation policy
  (`--no-git`) suppresses the branch and push even though the workspace
  `worker_task_args` include `--create-pr`.
- `allow_no_changes = true` with an `E2E_NO_CHANGE` prompt: the unchanged run
  succeeds and publishes no branch or commit (a local branch may still be
  recorded).
- `allow_no_changes` unset with the same prompt: the run fails with the
  documented missing-commit reason and publishes nothing.
- Occurrence markdown files exist under `<workspace>/automations/<id>/`,
  `automation_schedules` has one row per enabled automation, and no unconfigured
  automation produces a run.
- After the first window settles, a fifth automation is appended to
  `workspace.toml`; the live reloader reconciles it and its next occurrence
  records a `scheduled` run.

The file costs up to two cron boundaries for the main workspace (the first
window and the reloaded automation share a minute) plus one more for the opt-in
fixture, so allow roughly three minutes. Run it with the rest of the default
local suite:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Scheduled Jira story-point estimation

`tests/local/worker-scheduled-estimation.test.ts` starts one real
`devintern worker` with an `[[estimations]]` table against the in-process Jira
fake (`providers/fake-jira.ts`). No Jira project, token, or network access is
required. Build the CLI first; the test skips only when `packages/code/dist`
is absent, and a skip is not a pass.

The workspace is the usual temp worker fixture: isolated HOME, local bare Git
remote, deterministic agent, telemetry and license checks disabled. `[defaults].tracker`
is `jira` and the fake's environment is passed only into that process. Project
settings name `storyPointsField: "customfield_10016"`. The enabled entry uses
`interval = "15m"` and a JQL query. A second entry is disabled and would match
a decoy; it must not be scheduled.

The test does not sleep for the interval. It waits until the durable schedule
row is a future occurrence and no search has run, stops the worker, moves that
cursor into the past (several missed windows the first time), and starts again.
Startup coalesces those windows into one sweep. The fake records the JQL. The
sweep writes story points and one estimation comment on the issue created 48
hours earlier, records origin `estimate` with the schedule id, and invokes the
agent in estimate mode. An issue the same query selects but that was just
created is skipped for the 24 hour rule. The workspace defaults still contain
`--create-pr`; the sweep does not create a branch, pull request, or commit. A
second driven occurrence searches again and does not estimate the unchanged
issue.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Worker working windows

`tests/local/worker-working-windows.test.ts` verifies that a ready task waits outside the configured UTC windows and that `worker run-now` drains it once.

### Multi-repo team routing

`tests/local/worker-team-routing.test.ts` verifies team routing, ambiguous and unrouted task skips, and layered repo and team environment settings with local bare remotes.
