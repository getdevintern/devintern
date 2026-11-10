# E2E coverage matrix

Living inventory of what `packages/e2e` actually exercises, what it only
partially exercises, and what is still missing. The `e2e-expander` workspace
automation scouts this file and delegates the highest-value gaps to the worker
as separate ad-hoc tasks. Each delegated task updates this file in its own PR.

Last reviewed: 2026-11-07.

## Status legend

| Status    | Meaning                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| `default` | Runs in `bun run test` (offline, credential-free).                                                          |
| `live`    | Opt-in package script against a real service; requires credentials or local infrastructure.                 |
| `partial` | Some layers are covered, but the listed behavior or edge case is not.                                       |
| `gap`     | No end-to-end coverage; a unit test may exist.                                                              |
| `blocked` | Cannot be automated safely yet; record the exact prerequisite instead of adding a permanently skipped test. |

A row is `default` or `live` only when a test file is named. Tests are the source
of truth; this table is a snapshot.

## How to refresh the inventory

- Task-run surface: `packages/code/src/lib/cli/program.ts` (flags) and
  `packages/code/src/index.ts` (top-level dispatch).
- Worker surface: `packages/code/src/lib/worker/cli.ts` (subcommands and daemon)
  and the implementations under `packages/code/src/lib/worker/` and
  `packages/code/src/lib/workspace/`.
- Direct webhook surface: `packages/code/src/lib/code-host/cli.ts`,
  `packages/code/src/webhook-server.ts`, and `packages/code/src/lib/webhook/`.
- Intended behavior: `docs/code/*.md`.
- Existing suites: `packages/e2e/tests/{local,code,trackers}` and
  `packages/e2e/helpers/opt-in-suites.ts`.
- Run `bun run --filter @devintern/e2e test` for the default inventory; the
  suite lists every opt-in and planned suite as skipped or todo.

## External dependencies we do not control

These are the highest priority because provider APIs, CLIs, and binaries drift
independently of this repository.

### Task trackers

| Behavior                                                                          | Status    | Evidence                                                                          | Missing                                                                                        |
| --------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Markdown file tasks (single)                                                      | `default` | `tests/local/cli.test.ts`, `WorkerFixture`                                        | Markdown directory queries and status semantics are limited by design.                         |
| Multiple Markdown files and mixed tracker-key batches                             | `default` | `tests/local/cli-batch.test.ts`                                                   | Additional tracker combinations.                                                               |
| GitHub Issues: key and `--query`, status labels, summary comment, decoy isolation | `live`    | `tests/code/github-tracker.test.ts`                                               | Issue URL forms, comment-only estimation, reopen/closed handling.                              |
| Local GitLab Issues: key and `--query`, status labels, comment, decoy             | `live`    | `tests/code/gitlab-tracker.test.ts`                                               | Issue URL forms, estimation.                                                                   |
| GitLab.com Issues: key and `--query`                                              | `live`    | `tests/code/gitlab-com-tracker.test.ts`                                           | Estimation, reopen/closed handling.                                                            |
| Jira: offline fake key/`--query`, transition, comment, `--skip-comments`          | `default` | `tests/local/tracker-jira-fake.test.ts`, `bun run --filter @devintern/e2e test`   | Real Jira project lifecycle, issue create/close, estimation, live `--skip-comments` semantics. |
| Jira: live auth, project access, statuses, create metadata, JQL search            | `partial` | `test:trackers` read-only smoke                                                   | Full live create/transition/comment/close lifecycle; estimation.                               |
| Trello: offline fake key/`--query`, list move, comment, decoy isolation           | `default` | `tests/local/tracker-trello-fake.test.ts`, `test:trackers` read-only smoke        | Live board lifecycle and search indexing.                                                      |
| Linear: offline fake key/`--query`, workflow state, comment, decoy isolation      | `default` | `tests/local/tracker-linear-fake.test.ts`, `bun run --filter @devintern/e2e test` | Live team/project lifecycle, estimation, attachment uploads.                                   |
| Asana: offline fake key/`--query`, section transition, comment, decoy             | `default` | `tests/local/tracker-asana-fake.test.ts`                                          | Live project lifecycle.                                                                        |
| Azure DevOps                                                                      | `gap`     | detection only                                                                    | Read-only checks and lifecycle.                                                                |
| Offline fake Jira server (default lifecycle)                                      | `default` | `tests/local/tracker-jira-fake.test.ts`, `bun run --filter @devintern/e2e test`   | Real Jira create/close and estimation.                                                         |
| Offline fake Linear server (default lifecycle)                                    | `default` | `tests/local/tracker-linear-fake.test.ts`, `bun run --filter @devintern/e2e test` | Live team/project lifecycle, estimation, attachment uploads.                                   |
| Offline fake Trello server                                                        | `default` | `tests/local/tracker-trello-fake.test.ts`                                         | Live board lifecycle.                                                                          |

### Source control

| Behavior                                                                                   | Status    | Evidence                              | Missing                                                                                 |
| ------------------------------------------------------------------------------------------ | --------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| GitHub.com: implement, push, PR, base/title/body/diff/labels                               | `live`    | `tests/code/github.test.ts`           | Draft PRs, branch protection, merge queue, SSH remotes, Enterprise.                     |
| GitHub agent failure/no-change and existing-branch collision                               | `live`    | `tests/code/github-lifecycle.test.ts` | —                                                                                       |
| GitHub: review feedback polling and reply/dedup                                            | `gap`     | —                                     | Worker parity with the GitLab review scenario.                                          |
| GitHub: CI failure repair and retry budget                                                 | `gap`     | —                                     | Worker parity with the GitLab CI scenarios.                                             |
| GitHub: automatic merge-conflict resolution and scheduled mode                             | `gap`     | —                                     | Worker parity with the GitLab conflict scenario.                                        |
| GitHub: `@mention` handling                                                                | `gap`     | —                                     | —                                                                                       |
| GitHub: `--auto-review` loop and iteration cap                                             | `default` | `tests/local/cli-auto-review.test.ts` | Provider parity: real PR review feedback on GitHub/GitLab remains live/opt-in.          |
| GitLab Self-Managed: MR, default branch, invalid API credentials                           | `live`    | `tests/code/gitlab.test.ts`           | —                                                                                       |
| GitLab Self-Managed: collision, rejected push, address-review                              | `live`    | `tests/code/gitlab-lifecycle.test.ts` | Standalone `address-review` CLI options.                                                |
| GitLab Self-Managed worker: injected task, polling, CI repair/escalation, review, conflict | `live`    | `tests/code/gitlab-worker.test.ts`    | Automations, estimations, quiet hours, failover, orphan recovery, service, auto-update. |
| GitLab.com: implement, push, MR, invalid API credentials                                   | `live`    | `tests/code/gitlab-com.test.ts`       | Worker/lifecycle/review/CI/conflict coverage.                                           |
| Bitbucket Cloud: implement, push, PR, invalid API credentials                              | `live`    | `tests/code/bitbucket.test.ts`        | Worker/lifecycle/review/CI/conflict coverage.                                           |
| GitHub Enterprise / custom CA / proxy / SSH aliases                                        | `blocked` | README documents the omission         | Needs dedicated infrastructure; do not fake it.                                         |

### Sandboxing

Run: `bun run --filter @devintern/e2e test` (build the CLI first); the sandbox suite is `tests/local/sandbox.test.ts`.

| Behavior                                                                                | Status    | Evidence                      | Missing                                                                                                                |
| --------------------------------------------------------------------------------------- | --------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| nono availability, preflight, write boundary, fail-closed, inheritance (when installed) | `default` | `tests/local/sandbox.test.ts` | Network policy and pack updates.                                                                                       |
| `auto` provider selection                                                               | `partial` | `tests/local/sandbox.test.ts` | Native harness path, fallback when the preferred provider exists but cannot start, and other harness chains.           |
| `native` provider (claude-code, codex)                                                  | `partial` | `tests/local/sandbox.test.ts` | Real agent run under the native sandbox (needs an agent account); preflight/doctor covered with stubs.                 |
| `docker` provider                                                                       | `partial` | `tests/local/sandbox.test.ts` | Real boundary needs signed-in `sbx` and a guest agent, which the shell probe cannot drive; fail-closed/doctor covered. |
| Removed providers (`srt`, `smolvm`)                                                     | `default` | `tests/local/sandbox.test.ts` | Both fail with a migration message naming `nono`/`docker`.                                                             |
| Sandbox grants for `injected/`, `state/`, `automations/`                                | `gap`     | —                             | `worker add` and automation writes under a sandbox.                                                                    |

### Agent harnesses and failover

| Behavior                                                                     | Status    | Evidence                                                                                                                                                                                                                                                            | Missing                                                         |
| ---------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Installed harness invocation argv (all registered harnesses, when installed) | `default` | `tests/local/harness-invocation.test.ts`                                                                                                                                                                                                                            | Full agent task per harness.                                    |
| Deterministic fake agent implementation/review/CI/conflict modes             | `default` | `tests/local/harness.test.ts`                                                                                                                                                                                                                                       | —                                                               |
| Multi-harness failover on usage limit                                        | `default` | `tests/local/worker-harness-failover.test.ts` (injected tasks) and `tests/local/worker-conflict-failover.test.ts` (worker conflict-resolution failover: quota-then-success and all-harness deferral). `bun run build`, then `bun run --filter @devintern/e2e test`. | Real harness limit text drift, failback after the reset window. |

### Relay, auth, licensing, and observability services

| Behavior                                                                                                               | Status    | Evidence                                                                     | Missing                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GitLab relay: delivery, MR-close unwatch, `--disconnect`                                                               | `live`    | `tests/code/gitlab-relay.test.ts`                                            | GitHub relay delivery and tracker webhooks.                                                |
| `worker connect` targets (`github`, `gitlab`, `linear`, `asana`, `trello`, `azure-devops`, `jira`, `sentry`, `status`) | `gap`     | —                                                                            | Validation, `status`, and non-mutating paths; relay targets stay live/opt-in.              |
| Supabase login/logout/whoami and session refresh                                                                       | `gap`     | —                                                                            | Safe local fake or explicit opt-in account suite.                                          |
| Automation license gate, Worker Pilot trial, offline/expired behavior                                                  | `gap`     | —                                                                            | Tests currently disable the gate.                                                          |
| Sentry error-monitor polling and auto-fix                                                                              | `default` | `tests/local/worker-sentry-monitor.test.ts`                                  | Live Sentry project; issue status resolution after deployment; multiple concurrent issues. |
| Dashboard standalone server/API and run history                                                                        | `default` | `tests/local/dashboard-api.test.ts`                                          | Retry and run-now API assertions.                                                          |
| Worker/dashboard logs and artifacts                                                                                    | `partial` | asserted indirectly by worker tests                                          | Direct readback and redaction checks.                                                      |
| Direct webhook server (`webhook serve`) and signature validation                                                       | `default` | `tests/local/webhook-serve.test.ts` (`bun run --filter @devintern/e2e test`) | Live provider callbacks and event-specific pipelines; loopback HTTP only.                  |
| Anonymous telemetry opt-out and update check                                                                           | `gap`     | —                                                                            | Tests disable both; assert no network when disabled.                                       |

## `devintern` command surface

| Command / flag                                                           | Status             | Evidence                                                                                                                                                                                                                                       | Missing                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Single task key or local Markdown file                                   | `default`          | `tests/local/cli.test.ts`                                                                                                                                                                                                                      | —                                                                                                                                 |
| Multiple task keys and mixed Markdown/tracker batches                    | `default`          | `tests/local/cli-batch.test.ts`                                                                                                                                                                                                                | Additional tracker combinations.                                                                                                  |
| `--query` across trackers                                                | `default` / `live` | `tests/local/tracker-jira-fake.test.ts`, `tests/local/tracker-linear-fake.test.ts`, live tracker suites                                                                                                                                        | Azure.                                                                                                                            |
| `--create-pr`, `--pr-target-branch` explicit                             | `default` / `live` | local + provider suites                                                                                                                                                                                                                        | Implicit target is live-only on GitLab; add GitHub coverage.                                                                      |
| `--skip-clarity-check`, `--skip-comments`, `--no-update`, `--agent-path` | `default`          | local suites                                                                                                                                                                                                                                   | —                                                                                                                                 |
| `--allow-no-changes`                                                     | `gap`              | —                                                                                                                                                                                                                                              | Agent no-op run exits successfully and creates no PR.                                                                             |
| `--force`                                                                | `default`          | `tests/local/tracker-force-retry-gate.test.ts`                                                                                                                                                                                                 | Additional trackers.                                                                                                              |
| `--no-git`, `--no-auto-commit`                                           | `default`          | `tests/local/cli-git-delivery.test.ts` (`bun run --filter @devintern/e2e test`)                                                                                                                                                                | —                                                                                                                                 |
| `--estimate`                                                             | `gap`              | —                                                                                                                                                                                                                                              | Per-tracker story-point write/comment.                                                                                            |
| `--auto-review`, `--auto-review-iterations`                              | `default`          | `tests/local/cli-auto-review.test.ts` (`bun run --filter @devintern/e2e test`)                                                                                                                                                                 | Provider parity: live PR review feedback remains opt-in.                                                                          |
| `--env-file`                                                             | `default`          | `tests/local/cli-env-file.test.ts` (`bun run --filter @devintern/e2e test`)                                                                                                                                                                    | —                                                                                                                                 |
| `--max-turns`, `--hook-retries`                                          | `partial`          | helper passes `--hook-retries`                                                                                                                                                                                                                 | Failure/retry path.                                                                                                               |
| `--sandbox <provider>`                                                   | `partial`          | `tests/local/sandbox.test.ts` (per-provider fail-closed, removed srt/smolvm migration, native/goose rejection, unknown value)                                                                                                                  | Real run per provider remains optional.                                                                                           |
| `--verbose`, deprecated `--jql`, `--claude-path`, `--skip-jira-comments` | `gap`              | —                                                                                                                                                                                                                                              | Compatibility and warning paths.                                                                                                  |
| `init`                                                                   | `gap`              | —                                                                                                                                                                                                                                              | Non-interactive failure and scaffold alternatives.                                                                                |
| `workspace`                                                              | `gap`              | —                                                                                                                                                                                                                                              | Help/error redirect only; low value.                                                                                              |
| `dashboard`                                                              | `gap`              | —                                                                                                                                                                                                                                              | Standalone server and API.                                                                                                        |
| `webhook serve`                                                          | `default`          | `tests/local/webhook-serve.test.ts` (`bun run --filter @devintern/e2e test`)                                                                                                                                                                   | Live provider callbacks and event-specific pipelines.                                                                             |
| `address-review`                                                         | `partial`          | GitLab live lifecycle                                                                                                                                                                                                                          | GitHub; `--no-push`, `--no-reply`, `--ci-feedback`, `--expected-head`.                                                            |
| `resolve-conflicts`                                                      | `partial`          | `tests/local/worker-conflict-failover.test.ts` asserts the standalone first-harness-only contract and a nonzero exhausted-primary result (`bun run build`, then `bun run --filter @devintern/e2e test`). GitLab worker auto mode remains live. | Scheduled/disabled modes and live provider options this story does not claim. One-shot multi-harness failover is not implemented. |
| `login`, `logout`, `whoami`                                              | `gap`              | —                                                                                                                                                                                                                                              | Local fake session or opt-in account suite.                                                                                       |
| `sandbox`                                                                | `default`          | `tests/local/sandbox.test.ts` (provider matrix, native auto, missing harness, invalid/unreachable, removed srt/smolvm)                                                                                                                         | —                                                                                                                                 |
| `doctor`                                                                 | `default`          | `tests/local/cli-doctor.test.ts` (`bun run --filter @devintern/e2e test`)                                                                                                                                                                      | Live session/license opt-in; nonexistent Markdown dir passes.                                                                     |
| `report`                                                                 | `default`          | `tests/local/cli-report.test.ts`                                                                                                                                                                                                               | Additional platform permission scenarios.                                                                                         |

## `devintern worker` surface

| Behavior                                                                                                | Status             | Evidence                                                                                  | Missing                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Daemon: injected task drain, branch/PR, run record, worktree cleanup, graceful stop                     | `default` / `live` | `tests/local/worker.test.ts`, `tests/code/gitlab-worker.test.ts`                          | —                                                                                |
| Tracker polling and actioned deduplication                                                              | `live`             | GitLab worker suite                                                                       | GitHub/Jira/Trello/Linear/Asana/Azure worker paths.                              |
| Scheduled `[[automations]]`: schedule, no-op, branch/push policy, hot reload                            | `default`          | `tests/local/worker-automations.test.ts` (`bun run --filter @devintern/e2e test`)         | PR creation on a live code host (bare remote exposes no platform).               |
| Scheduled `[[estimations]]`                                                                             | `gap`              | —                                                                                         | Fixture tracker and story-point assertion.                                       |
| Working windows / quiet hours                                                                           | `default`          | `tests/local/worker-working-windows.test.ts`                                              | Additional timezone and daylight-saving scenarios.                               |
| Workspace and per-repo concurrency                                                                      | `default`          | `tests/local/worker-concurrency.test.ts`                                                  | More than two repositories and mixed work sources.                               |
| Orphan recovery after a crash                                                                           | `default`          | `tests/local/worker-orphan-recovery.test.ts`                                              | Additional crash timing scenarios.                                               |
| Harness failover                                                                                        | `default`          | `tests/local/worker-harness-failover.test.ts`                                             | Failback after the reset window and restart-time restore of the persisted chain. |
| Review polling, CI repair, conflict resolution                                                          | `live`             | GitLab worker suite                                                                       | GitHub parity and scheduled/manual modes.                                        |
| Relay instant events                                                                                    | `live`             | GitLab relay suite                                                                        | GitHub relay and tracker webhooks.                                               |
| Sentry error monitors                                                                                   | `default`          | `tests/local/worker-sentry-monitor.test.ts`                                               | Live Sentry project and multiple concurrent issues.                              |
| Dashboard embedded in the worker                                                                        | `gap`              | —                                                                                         | API and run-now/retry.                                                           |
| Native service install/uninstall                                                                        | `gap`              | —                                                                                         | systemd/launchd path without touching the host service manager.                  |
| Auto-update                                                                                             | `gap`              | —                                                                                         | Disabled in tests; simulate an available update safely.                          |
| Team routing, `env_file`, per-repo env                                                                  | `default`          | `tests/local/worker-team-routing.test.ts`                                                 | Additional team and repo combinations.                                           |
| `worker init`                                                                                           | `gap`              | —                                                                                         | Non-interactive failure and prompt-free path.                                    |
| `worker login`                                                                                          | `gap`              | —                                                                                         | Session isolation from project login.                                            |
| `worker scaffold`                                                                                       | `default`          | `tests/local/worker-workspace-bootstrap.test.ts` (`bun run --filter @devintern/e2e test`) | —                                                                                |
| `worker add-repo`                                                                                       | `default`          | `tests/local/worker-workspace-bootstrap.test.ts` (`bun run --filter @devintern/e2e test`) | —                                                                                |
| `worker add`: `--title`, `--body`, `--json`                                                             | `default`          | `WorkerFixture.addTask`                                                                   | —                                                                                |
| `worker add`: `--body-file`, `--idempotency-key`, `--resume`, `--wait`, `--wait-timeout`, `--workspace` | `default`          | `tests/local/worker-add-options.test.ts` (`bun run --filter @devintern/e2e test`)         | —                                                                                |
| `worker connect`                                                                                        | `gap`              | —                                                                                         | See external section.                                                            |
| `worker run-now`                                                                                        | `default`          | `tests/local/worker-working-windows.test.ts`                                              | Additional scheduling scenarios.                                                 |

## Delegation

The scout ranks every accepted gap by value and dispatches them with
`devintern worker add` in descending order, using stable
`e2e-<area>-<slug>` idempotency keys. There is no fixed per-run cap: it rejects
blocked or low-value candidates instead of padding the batch. It does not edit
this file itself; the delegated task updates the row in its PR. A gap with an
open PR, a merged test, or a queued/running task is not delegated again.

## Priority backlog

Work top to bottom; the scout delegates every accepted gap highest-value first,
and each task opens its own PR.

1. ~~Offline fake Jira server with the lifecycle assertions from Layer 2~~
   (implemented by `tests/local/tracker-jira-fake.test.ts`).
2. ~~Offline fake Trello server with the card/list/comment lifecycle~~
   (implemented by `tests/local/tracker-trello-fake.test.ts`).
3. Jira lifecycle against a dedicated fixture project (Layer 2), when that
   project and token exist.
4. Trello lifecycle against a dedicated board (Layer 2), when that board and
   token exist.
5. GitHub worker parity: review polling, CI repair, conflict resolution, mention.
6. ~~`--auto-review` loop and iteration cap on GitHub and GitLab~~ (the local
   loop/cap is implemented by `tests/local/cli-auto-review.test.ts`; provider
   parity with real PR review feedback remains live/opt-in).
7. `worker add` full option matrix (`--body-file`, idempotency, resume, wait,
   wait-timeout, workspace, validation and deduplication).
8. `worker scaffold`, `add-repo`, `run-now`, and `connect status` in temp homes.
9. Standalone `address-review` options, plus `resolve-conflicts` scheduled/disabled
   modes and live provider options. The offline first-harness-only contract is
   covered by `tests/local/worker-conflict-failover.test.ts`.
10. `dashboard` standalone/embedded API, run-now, retry, and log redaction.
11. `webhook serve` with signed GitHub/GitLab payloads.
12. Sandbox providers `native`, `nono`, and `docker`, removed-provider (`srt`,
    `smolvm`) migration errors, plus invalid-provider and missing-binary
    fail-closed paths.
13. Estimations, quiet hours, concurrency, and orphan recovery on a deterministic
    local workspace. Scheduled automations are implemented by
    `tests/local/worker-automations.test.ts`.
14. ~~Harness failover with stub harnesses~~ (injected tasks in
    `tests/local/worker-harness-failover.test.ts`; worker conflict-resolution
    failover in `tests/local/worker-conflict-failover.test.ts`). Failback after
    the reset window is still open.
15. Sentry auto-fix with a fake or opt-in project.
16. Auth/license (`login`, `logout`, `whoami`, trial, expired/offline) with a
    safe fake or explicit account suite.
17. ~~Linear fake lifecycle~~ (implemented by
    `tests/local/tracker-linear-fake.test.ts`); Linear read-only checks plus
    Asana and Azure DevOps read-only checks, then fake lifecycles.
18. Native service install and auto-update in a sandboxed user-scope fixture.
19. GitHub Enterprise, custom CAs, proxies, and SSH aliases only when dedicated
    infrastructure exists.

## Rules for adding a row

- Name the exact test file and the command that runs it.
- Do not mark `default` for a test that skips without credentials or remote
  infrastructure. Optional local binaries (nono, harness CLIs) are allowed only
  when the skip is explicit and the test still proves the fallback path.
- Do not mark `live` without running it on this machine at least once; otherwise
  keep it `gap`/`blocked` and state the prerequisite.
- Record cleanup ownership in the evidence column when the suite creates remote
  resources.
- Never write to a production tracker or repository. Use a disposable local
  project, a dedicated fixture, or a fake server.
