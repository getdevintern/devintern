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
- Evidence: GitLab worker suite; `tests/code/github-tracker-worker.test.ts` (`test:e2e:tracker`) for GitHub Issues
- Missing: Jira, Trello, Azure DevOps, Linear, and Asana: see the tracker files.
- Last reviewed: 2026-11-26

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
- Evidence: GitLab worker suite; offline GitLab enabled paths in `tests/local/worker-conflict-failover.test.ts` and `tests/local/worker-relay-gitlab-events.test.ts`; opt-outs in the two rows below.
- Missing: GitHub parity (`code-host/github/reviews.ts` hardcodes `https://api.github.com`, so it cannot be faked offline) and `conflict_resolution = "scheduled"` (scheduled windows do not process GitLab MRs yet).
- Last reviewed: 2026-11-28

### GitLab `conflict_resolution = "disabled"` leaves a conflicting agent MR alone

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-gitlab-follow-up-opt-outs.test.ts` (`bun run --filter @devintern/e2e test`). A registered MR whose branch conflicts with its target (proved with `git merge-tree`) is polled every second. Over four registered-MR poll ticks (counted from the forge's request log), and after a relay `change.changed` hint for the MR, the worker runs no agent, pushes nothing, writes nothing to the forge (no note, no merge), leaves both branch tips unchanged, marks no conflict sync processed, and `worker runs --json` lists no run. Positive control in the same harness: a live switch to `"auto"` in `workspace.toml` resolves the MR once (one conflict agent run, a merge commit of the old head and the target, a plain `git push origin <branch>`), from the next poll tick or the next `change.changed`.
- Missing: The webhook (`devintern webhook serve`) conflict path with `"disabled"`; `"scheduled"` on GitLab (not implemented).
- Last reviewed: 2026-11-28

### GitLab `ci_failure_fix = false` runs no CI repair

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-gitlab-follow-up-opt-outs.test.ts`. The forge serves a failed pipeline and job for the registered MR's current head. With `ci_failure_fix = false` the worker logs `CI failure fixes disabled` at startup and, over four poll ticks and after a relay `ci.changed` hint, reads no pipeline, job, trace, or commit status, runs no agent, pushes no commit, writes nothing to the forge, and records no `ci_fix` run. Positive control in the same harness: a live switch to `true` runs exactly one CI repair (the failed job name and trace reach the prompt, one fast-forward commit, one `ci_fix` run). A live switch back to `false`, followed by a failed pipeline on the repair commit, reads no CI and runs nothing. The live reload is covered because `docs/code/pr-follow-up.md` documents these settings as applying without a restart.
- Missing: The webhook (`devintern webhook serve`) Pipeline/Job path with `ci_failure_fix = false`. The default is `false` (`DEFAULT_CI_FAILURE_FIX`), so the positive control sets `true` explicitly. The relay `ci.changed` positive control is in `worker-relay-gitlab-events.test.ts`, not repeated here.
- Last reviewed: 2026-11-28

### Native service install/uninstall

- Surface: `devintern worker` surface
- Status: `partial`
- Evidence: `tests/service/systemd-service.test.ts` (`bun run --filter @devintern/e2e test:e2e:service`; needs Docker). In a systemd container, `devintern worker service install` runs with no TTY: unlicensed it is refused (exit 2) and installs nothing; with `--force` it reports the license failure (exit 1, `start.permanent`), the unit ends `failed` with status 78 and no restarts, the reason is in `worker.stderr.log`, and `worker status` says the start failed. With the license bypass it reports a running worker; the unit has an absolute Bun runtime and bundle path, the recorded `PATH`, `WorkingDirectory=~/.devintern`, and `RestartPreventExitStatus=78`; the service reads the workspace `.env` and pushes a markdown task branch; `worker status` and `/api/worker` report the service pid; `kill -9` is restarted by systemd; `service stop` ends inactive with `Result=success` and exit 0 after "👋 Worker stopped", and `worker status` says stopped; `start` and `restart` wait for a running worker; a wizard run updates the unit in place; a `loginctl` that cannot enable lingering yields the `sudo loginctl enable-linger tester` warning; `uninstall` removes the unit and is idempotent.
- Missing: launchd (macOS); a real polkit-less `loginctl enable-linger` failure (the suite enables lingering as root so the user manager runs, and stubs `loginctl` for the warning).
- Last reviewed: 2026-11-26

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

### Workspace pipeline_file: plugin steps run in order and a halt stops delivery

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-pipeline-file.test.ts` (`bun run --filter @devintern/e2e test`). A `[[repos]].pipeline_file` with `plugins: ["./steps/gate.ts"]` loads the TypeScript module from the workspace through the built CLI and runs it after `commit` with the step entry (minus `use`) as `create(config)`. `halt` ends the run `escalated` with the reason as `outcome_reason`, `failureStage`, and `failureCause`, marks the implementation stage failed, writes `implementation-summary-incomplete.md`, and skips `finalize`: no publish push and no PR attempt. With default settings the halted run's committed work is pushed to `feature/<key>` (unfinished-work preservation, `outcome_reason` names the branch); with `DEVINTERN_PUSH_UNFINISHED_WORK=0` the bare remote has no task branch. `warn` prints the warning after `commit`, and delivery continues through `finalize` to the push.
- Missing: Built-in `verify` (model-driven) and `repeat` results; `haltKind: "stop"`; `StepExecutionError` retry; PR creation on a live code host (the bare remote has none). The warning appears only in the task log, not on the run record or `worker runs show`.
- Last reviewed: 2026-11-27

### Workspace pipeline_file precedence: [[repos]] over [defaults] over built-in

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-pipeline-file.test.ts`. In a two-repo workspace, repo A with its own `pipeline_file` runs only A's plugin step, and repo B runs only `[defaults].pipeline_file`'s step. Per-step markers carrying the pinned repo name show the lists were not merged. Both repositories commit a `.devintern-code/settings.json` `pipeline` whose own plugin never runs, and the worker prints "defines a pipeline, which is not read" for each. Each task logs its selected scope and file, and both branches are pushed.
- Missing: Live reload of `[defaults].pipeline_file` between tasks; team-routed (tracker-polled) tasks; `~/` and absolute `pipeline_file` forms; package-name plugins.
- Last reviewed: 2026-11-27

### Invalid or missing workspace pipeline_file fails the run closed

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-pipeline-file.test.ts`. A `pipeline_file` that does not exist, one with a plugin step after `finalize`, and one whose plugin is named `verify` (reserved) each fail the run: the queue row is `failed`, the run is `failed` with an `outcome_reason` naming the repository and the file, and the task log carries the full error. The task logs no `🧩 Pipeline:` line (no built-in fallback), no commit, and no push; the bare remote keeps only the base branch. Observed: validation runs before the agent, so the fake agent was never started and no plugin step ran. The worker keeps running.
- Missing: Invalid JSON and a non-array `steps`; an invalid `[defaults].pipeline_file`; a plugin module that fails to import.
- Last reviewed: 2026-11-27

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 13: Quiet hours, concurrency, and orphan recovery on a deterministic local workspace. Scheduled automations are implemented by `tests/local/worker-automations.test.ts`. Scheduled estimations are implemented by `tests/local/worker-scheduled-estimation.test.ts`.
- Priority 18: Native service install and auto-update in a sandboxed user-scope fixture. The systemd install is covered by `tests/service/systemd-service.test.ts`; launchd and auto-update remain.

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
  `workspace.toml`; the live reloader registers it with the next
  `* * * * *` minute boundary as its cursor. Unless that boundary is under
  five seconds away, the test moves the cursor to just ahead of now and appends
  a disabled entry to trigger a second reload, which re-arms the live timer
  from the moved cursor. The timer (not a startup tick) then claims the
  occurrence and records a `scheduled` run.

No case waits for a real cron boundary: due occurrences come from a restart
with moved cursors or from the re-armed live timer, so the file takes well
under a minute. Run it with the rest of the default local suite:

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

### Native systemd service

- Proves: `devintern worker service` on a blank Debian box with systemd as PID 1, with no TTY: the readiness refusal and the honest license-failure report (unit `failed`, status 78, no restart loop, reason in the worker log and `worker status`), then with a license a running worker (unit contents, enabled and active), that the service loads `~/.devintern/.env` (license skip, agent path, `MARKDOWN_TASKS_DIR`) and pushes a task branch to a local bare remote (on a host with no global git config, so the commit carries the `DevIntern` fallback identity), that `worker status` and the dashboard see the service pid, restart after `kill -9`, a clean `stop` (inactive, exit 0, status stopped), `start`/`restart`, an in-place update from the wizard, the lingering warning, and `uninstall`.
- How: `scripts/service.ts` packs the built CLI with `bun pm pack`; `helpers/systemd-container.ts` builds `infrastructure/service/Dockerfile`, which installs the tarball with `bun add -g` for a non-root user, starts a privileged container (never `--network host`), and enables lingering as root. `worker init --non-interactive` writes the markdown workspace without the license bypass; the suite adds `DEVINTERN_SKIP_LICENSE_CHECK=1` to the workspace `.env` only for the success path. `expect` drives the interactive wizard for the in-place update. The workspace `.env` sets `TASK_TRACKER=markdown`, because the wizard reads the tracker from there and not from `[defaults].tracker`. The lingering warning uses a stub `loginctl` on `PATH` for that one install.
- Run: `bun run --filter @devintern/e2e test:e2e:service`.
- Prerequisites: the built CLI and a Docker daemon your user can access. No network credentials. The first run builds the image (about a minute); the suite then takes about 45 s, most of it the unit's `RestartSec=30`. The container is removed afterwards; the `devintern-e2e-systemd:local` image stays cached.

### tests/local/worker-pipeline-file.test.ts

- Proves: workspace `pipeline_file` behavior in a real `devintern worker` run of the built CLI. A plugin step runs between `commit` and `finalize` and receives its options. `halt` stops delivery and `warn` continues to the push. A `[[repos]]` file wins over `[defaults]` and the two are never merged, and a committed checkout `pipeline` is ignored with a warning. Missing or invalid files fail the run closed before the agent starts.
- How: `WorkerFixture` (gaps 1 and 3) and `MultiRepoWorkerFixture` (precedence) with local bare remotes, ad-hoc tasks via `worker add`, and the deterministic fake agent in its normal implement mode. `helpers/pipeline-file.ts` writes `<workspace>/pipelines/*.json` and dependency-free plugin modules under `pipelines/steps/`. Each plugin writes a JSON marker (step, pinned repo, task key, `create(config)` options, `committed`) to a test-owned directory, and the task prompt selects `halt` or `warn`. Assertions read the queue and run rows, `worker runs show --json`, `git ls-remote --heads` on the bare remotes, the markers, and the worker log.
- Run: `bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test` (or `bun test tests/local/worker-pipeline-file.test.ts` from `packages/e2e`).
- Prerequisites: the built CLI only. No network or credentials. About 10 s for the three tests.

### tests/local/worker-gitlab-follow-up-opt-outs.test.ts

- Proves: the GitLab follow-up kill switches on a running `devintern worker`. `[workspace].conflict_resolution = "disabled"` leaves a conflicting registered MR alone, and `[workspace].ci_failure_fix = false` runs no CI repair for a failed pipeline on the MR's head. Both hold on poll ticks and for relay hints (`change.changed`, `ci.changed`). Each case then edits `workspace.toml` live as a positive control: `"auto"` resolves the conflict once, and `true` runs one CI repair. Switching CI fix back to `false` stops it again.
- How: `WorkerFixture` with the deterministic fake agent, a loopback `FakeGitlabForge` (optional `ci` failure), and git fetch/push rewritten onto the local bare repository by `helpers/gitlab-worker-follow-up.ts` (shared with `worker-conflict-failover.test.ts` and `worker-relay-gitlab-events.test.ts`), which also registers MR !1 in `agent_prs`. The poll cases use `poll_interval = 1` and count `merge_requests/1/discussions` reads as completed ticks, not sleeps. The relay case uses `FakeRelay` with `poll_interval = 3600` and waits for the cursor to move past each envelope. The forge and relay tokens are random per test. A refusing recording proxy is set as `HTTP(S)_PROXY`, and the test asserts it saw no request, and that no token (raw or URL-encoded) appears in worker output, `worker runs --json`, forge notes, or files under the fixture root. Assertions read the forge request and mutation logs, the git argv log, the bare repository, `processed_events`, the run table, and `worker runs --json`.
- Run: `bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test` (or `bun test tests/local/worker-gitlab-follow-up-opt-outs.test.ts` from `packages/e2e`).
- Prerequisites: the built CLI and `git`. No network or credentials. About 20 s for the three tests.
