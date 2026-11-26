# `devintern` command e2e coverage

Scope: the one-shot `devintern` task-run command and its flags, plus the standalone `address-review`, `resolve-conflicts`, `init`, `workspace`, `doctor`, and `report` commands. Dashboard, webhook, sandbox, and auth commands live in their own area files.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Single task key or local Markdown file

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/cli.test.ts`
- Missing: —
- Last reviewed: 2026-11-17

### Multiple task keys and mixed Markdown/tracker batches

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/cli-batch.test.ts`
- Missing: Additional tracker combinations.
- Last reviewed: 2026-11-17

### `--query` across trackers

- Surface: `devintern` command surface
- Status: `default` / `live`
- Evidence: `tests/local/tracker-jira-fake.test.ts`, `tests/local/tracker-linear-fake.test.ts`, live tracker suites
- Missing: Additional tracker combinations.
- Last reviewed: 2026-11-17

### `--create-pr`, `--pr-target-branch` explicit

- Surface: `devintern` command surface
- Status: `default` / `live`
- Evidence: local + provider suites
- Missing: Implicit target is live-only on GitLab; add GitHub coverage.
- Last reviewed: 2026-11-17

### `--skip-clarity-check`, `--skip-comments`, `--no-update`, `--agent-path`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: local suites
- Missing: —
- Last reviewed: 2026-11-17

### `--allow-no-changes`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/cli-allow-no-changes.test.ts` (`bun run --filter @devintern/e2e test`): no-op exits non-zero without the flag, 0 with it; `--no-git` no-op succeeds either way (flag irrelevant); no PR or push; offline Jira comment/status.
- Missing: Live code-host parity. Observed (unconfirmed intent): a no-op leaves the tracker ticket in progress with no comment.
- Last reviewed: 2026-11-17

### `--force`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/tracker-force-retry-gate.test.ts`
- Missing: Additional trackers.
- Last reviewed: 2026-11-17

### `--no-git`, `--no-auto-commit`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/cli-git-delivery.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: —
- Last reviewed: 2026-11-17

### Commit identity on a host without git config

- Surface: task delivery (`git_author_*` setting, DevIntern fallback)
- Status: `default`
- Evidence: `tests/local/cli-git-delivery.test.ts` (`bun run --filter @devintern/e2e test`): the run gets no `GIT_AUTHOR_*`/`GIT_COMMITTER_*` and no global config, and the pushed commit carries the `DEVINTERN_GIT_AUTHOR_*` setting or the `DevIntern` fallback; no `user.*` is written to the checkout config
- Missing: the `GITHUB_TOKEN`-derived identity against the real `GET /user` (unit-tested with a fake API)
- Last reviewed: 2026-11-26

### `--estimate`

- Surface: `devintern` command surface
- Status: `gap`
- Evidence: —
- Missing: Per-tracker story-point write/comment.
- Last reviewed: 2026-11-17

### `--auto-review`, `--auto-review-iterations`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/cli-auto-review.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Provider parity: live PR review feedback remains opt-in.
- Last reviewed: 2026-11-17

### `--env-file`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/cli-env-file.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: —
- Last reviewed: 2026-11-17

### `--hook-retries` (task-run commit repair loop and cap)

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/cli-hook-retries.test.ts` (`bun run --filter @devintern/e2e test`): real failing pre-commit hook; repaired retry, `Commit already completed during hook fix`, cap of 1, and 0 retries
- Missing: Push-side (pre-push) hook repair; `address-review` and webhook review loops.
- Last reviewed: 2026-11-17

### `--max-turns`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/cli-hook-retries.test.ts` (`bun run --filter @devintern/e2e test`): an argv-recording agent stub proves `--max-turns 7` reaches claude-code's `--max-turns` on both the implementation and the git-hook repair invocation, and the default `500` reaches both when the flag is omitted.
- Missing: Other harnesses' turn-limit flags through the CLI (builder-level only in `harness-invocation.test.ts`); push-side hook repair, auto-review, and worker paths.
- Last reviewed: 2026-11-19

### `--verbose`, deprecated `--jql`, `--claude-path`, `--skip-jira-comments`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/cli-deprecated-flags.test.ts` (`bun run --filter @devintern/e2e test`) against the offline fake Jira: `--jql` prints `--jql is deprecated, use --query instead` and selects only the matching issue (decoy untouched); `--claude-path` routes the run to the given agent (recorded argv, and `--verbose` prints it as the resolved harness path); `--skip-jira-comments` prints `--skip-jira-comments is deprecated, use --skip-comments instead`, delivers the branch, and posts no comment or status change.
- Missing: `--claude-path` prints no deprecation warning (observed product behavior, asserted as-is). Precedence when an alias and its canonical flag are both passed is not asserted.
- Last reviewed: 2026-11-19

### `init`

- Surface: `devintern` command surface
- Status: `gap`
- Evidence: —
- Missing: Non-interactive failure and scaffold alternatives.
- Last reviewed: 2026-11-17

### `workspace`

- Surface: `devintern` command surface
- Status: `gap`
- Evidence: —
- Missing: Help/error redirect only; low value.
- Last reviewed: 2026-11-17

### `address-review`

- Surface: `devintern` command surface
- Status: `partial`
- Evidence: GitLab live lifecycle. `tests/local/cli-address-review.test.ts` runs it standalone against the fake GitLab forge: default push and reply, `--no-push`, `--no-reply`, `--ci-feedback`, stale and current `--expected-head`, and the missing-value errors (`bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`).
- Missing: GitHub, because `packages/code/src/lib/code-host/github/reviews.ts` hardcodes `https://api.github.com` and cannot be faked offline. Observed (unconfirmed intent): a stale `--expected-head` in plain review mode fails with "MR head changed before CI repair started; refusing stale feedback.", which names CI repair.
- Last reviewed: 2026-11-25

### `resolve-conflicts`

- Surface: `devintern` command surface
- Status: `partial`
- Evidence: `tests/local/worker-conflict-failover.test.ts` asserts the standalone first-harness-only contract and a nonzero exhausted-primary result. `tests/local/cli-resolve-conflicts.test.ts` runs it standalone on a conflicting MR against the fake GitLab forge: stale `--expected-head` / `--expected-base` defer with exit 2 and no agent run or push, `--no-push` leaves the remote unchanged, and current guards push a merge commit on top of the old head (`bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`). GitLab worker auto mode remains live.
- Missing: GitHub options (same `api.github.com` limit as `address-review`). Scheduled/disabled worker modes. One-shot multi-harness failover is not implemented. Observed (unconfirmed intent): the parser takes `args[++i]` unchecked, so a trailing `--expected-head` with no value runs with no head guard instead of failing as a usage error.
- Last reviewed: 2026-11-25

### `doctor`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/cli-doctor.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Live session/license opt-in; nonexistent Markdown dir passes.
- Last reviewed: 2026-11-17

### `report`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/cli-report.test.ts`
- Missing: Additional platform permission scenarios.
- Last reviewed: 2026-11-17

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 6: ~~`--auto-review` loop and iteration cap on GitHub and GitLab~~ (the local loop/cap is implemented by `tests/local/cli-auto-review.test.ts`; provider parity with real PR review feedback remains live/opt-in).
- Priority 9: `resolve-conflicts` scheduled/disabled worker modes, and GitHub `address-review` / `resolve-conflicts` options (needs an overridable GitHub API base). Standalone GitLab options are covered by `tests/local/cli-address-review.test.ts` and `tests/local/cli-resolve-conflicts.test.ts`; the offline first-harness-only contract by `tests/local/worker-conflict-failover.test.ts`.

## Test notes

### Local auto-review loop

`tests/local/cli-auto-review.test.ts` runs the built CLI's `--auto-review` loop
against a local bare Git remote and the deterministic fixture agent, with no
hosted PR, account, or network access. The fixture agent gains two prompt-driven
modes: `auto-review-feedback` (the bundled `review.md` prompt) prints only a
JSON verdict, and `auto-review-fix` (the bundled `fix.md` prompt) edits
`src/greeting.ts` without committing or pushing. The reviewer reports one
`medium` finding on iteration 1 and approves from iteration 2, so the loop
converges; `E2E_AUTO_REVIEW_STUCK=1` keeps every iteration unapproved to prove
`--auto-review-iterations` caps the review/fix cycles. Both modes are recorded
in `E2E_AGENT_INVOCATIONS` so the test asserts the exact
implement → review → fix → review sequence.

The scenarios assert the pushed `feature/<task-key>` branch, the exact
`src/greeting.ts` diff, the two commits ahead of base (the implementation plus
`fix: address PR review feedback`), and the
`DEVINTERN_OUTPUT_DIR/<task-key>/auto-review-summary.json` artifact
(`iterations`, `success`, and `history`). Per-iteration verdicts are saved under
`iteration-<n>/feedback.json`. A non-approved loop still exits 0 and delivers
the branch; the local remote has no supported PR host, so `--create-pr` pushes
and exits without a PR URL.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Local git-hook repair loop

`tests/local/cli-hook-retries.test.ts` installs a real executable pre-commit
hook (by repointing the fixture's pinned `core.hooksPath` at a per-test hooks
directory) that rejects the commit while staged `src/greeting.ts` carries a
per-test marker. With `E2E_HOOK_MARKER` set, the fixture agent's implementation
edit plants that marker, so the production commit fails through real
`git commit`. The bundled hook-fix prompt selects the prompt-driven `hook-fix`
mode, whose outcome `E2E_HOOK_FIX` controls: `fix` removes the marker and leaves
the commit to the production retry, `fix-commit` also commits itself, and `noop`
leaves the marker in place. Each repair turn is recorded in
`E2E_AGENT_INVOCATIONS` as `hook-fix`.

The scenarios prove a repaired retry pushes one marker-free implementation
commit to a local bare remote and writes
`DEVINTERN_OUTPUT_DIR/<task-key>/git-hook-errors.log` for attempt 1;
`--hook-retries 1` with an unrepairable hook runs exactly one repair turn,
prints `Max retries (1) exceeded`, exits non-zero, and pushes nothing;
`--hook-retries 0` fails without any repair turn; and an agent that commits
during the fix is delivered without a duplicate commit.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Incomplete task retry gate

`tests/local/tracker-force-retry-gate.test.ts` verifies that an unchanged incomplete Jira task is skipped until `--force` requests a retry.

### No-op runs (`--allow-no-changes`)

`tests/local/cli-allow-no-changes.test.ts` runs the built CLI with the fixture agent's `no-change` mode against a local bare remote. Without the flag, `--create-pr` exits non-zero with `Implementation was not committed` and records a `failed` run. With `--allow-no-changes`, it exits 0, records a `succeeded` run with no `pr_url`, and pushes no branch or commit. With `--no-git` the commit step is skipped, so the flag has no effect there: a no-op succeeds with or without it, and the suite runs both forms as a regression guard. Against the offline Jira fake, the failure path posts a failure comment and moves the ticket back to its todo status. The no-op path currently posts no comment and leaves the ticket in its in-progress status. The test asserts this as observed behaviour, not as a confirmed product contract.

### `--max-turns` forwarding

`tests/local/cli-hook-retries.test.ts` also proves the turn cap reaches the
harness. `helpers/argv-recorder.ts` writes an agent stub that appends its argv
as a JSON line and then runs the fixture agent with the same argv. The test
moves the fixture agent behind the stub at the `--agent-path` location, reuses
the failing pre-commit hook with the `fix` repair outcome, and asserts both
recorded invocations (implementation and `# Git Hook Error - Fix Required`)
carry exactly one `--max-turns 7`, or `--max-turns 500` when the flag is
omitted. The fixture's harness is `claude-code`.

### Deprecated flag aliases

`tests/local/cli-deprecated-flags.test.ts` runs the built CLI with an explicit
argv against the offline fake Jira (an expected issue plus a decoy). One run
passes `--jql`, `--claude-path` (the argv-recording stub), and `--verbose`: it
asserts the `--jql` warning, the fake's recorded search, a single succeeded
run for the matching issue, the implementation comment, the untouched decoy,
one recorded stub invocation, and the verbose `resolved to: <stub>` line. A
second run passes `--skip-jira-comments` and asserts its warning, a delivered
branch, and unchanged comments and status. `--claude-path` has no warning in
the product, so none is asserted.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Standalone `address-review` and `resolve-conflicts` (GitLab)

`tests/local/cli-address-review.test.ts` and `tests/local/cli-resolve-conflicts.test.ts` run the built CLI directly from the seeded checkout, with no worker or `webhook serve`. They use `openStandaloneScenario` in `helpers/gitlab-webhook-scenario.ts`: the same bare repo, loopback `FakeGitlabForge`, git `insteadOf` rewrite, and deterministic agent as the webhook tests. Credentials come from a plain project env (`GITLAB_CODE_HOST_URL`, `GITLAB_CODE_HOST_TOKEN`). No workspace is registered, so `workspaceCredentialsForChange` finds no `workspace.toml` and leaves the env alone.

- `address-review`: a missing `--ci-feedback` / `--expected-head` value exits 1 with no forge request or agent run. `--no-push` commits locally (the checkout's branch moves, the bare remote does not) and posts no reply. A stale `--expected-head` exits 1 with no agent run. The current head pushes a fast-forward and posts one discussion reply. `--no-reply` pushes and posts nothing. `--ci-feedback` (the `CiFailureFeedback` JSON the worker writes) puts the check name and log excerpt in the prompt, pushes the CI fix, and posts no reply even though the MR has an open discussion.
- `resolve-conflicts`: a stale `--expected-head` or `--expected-base` prints `Deferred: ...` and exits 2. `--no-push` runs the agent and leaves the remote and forge untouched. Current guards (`--expected-base` is GitLab's `diff_refs.base_sha`, the merge base) push a merge commit with parents `[old head, target tip]` and post one outcome note.

Every run asserts the forge token is absent from stdout and stderr, raw and URL-encoded. Run with the commands in [Run locally](../../README.md#run-locally).
