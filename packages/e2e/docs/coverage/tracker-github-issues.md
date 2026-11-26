# GitHub Issues tracker e2e coverage

Scope: GitHub Issues as the task tracker. Live run setup is in the [README](../../README.md#github-issues-tracker).

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### GitHub Issues: key and `--query`, status labels, summary comment, decoy isolation

- Surface: External dependency: task trackers
- Status: `live`
- Evidence: `tests/code/github-tracker.test.ts`
- Missing: Issue URL forms, comment-only estimation, reopen/closed handling.
- Last reviewed: 2026-11-17

### GitHub Issues: worker polling, status labels, summary comment, actioned dedupe

- Surface: `devintern worker` surface
- Status: `live`
- Evidence: `tests/code/github-tracker-worker.test.ts` (`test:e2e:tracker`)
- Missing: Relay task events, `@mention` handling, and review follow-up on the polled PR.
- Last reviewed: 2026-11-26

## Tracker plan status

### GitHub Issues

- Default `test`: no
- Opt-in suite: `test:e2e:tracker`
- Notes: Existing live suite; dedicated tracker repository doubles as code host.
- Last reviewed: 2026-11-17

## Test notes

### `tests/code/github-tracker-worker.test.ts`

- Proves: a long-lived `devintern worker` with `[defaults].tracker = "github"` finds a labelled issue through its own poll, opens a PR against the run's unique base that changes only `src/greeting.ts`, moves the status labels (To Do → In Review, In Progress removed, trigger and unrelated labels kept), posts the implementation comment, and skips the issue on later polls although the label changes updated it. A decoy with the same marker but no trigger label gets no run, comment, or label.
- How: `GitHubWorkerFixture` with its `issues` option writes the GitHub tracker query, `[trackers.github.projects."<repo>"]` statuses and `GITHUB_STATUS_LABELS`, and runs with comments on. The query is `is:open label:e2e-worker-ready <marker>`; the unique body marker keeps parallel runs apart. The poll interval is 5 s because every poll is a search request (30 per minute). Cleanup closes both issues, closes the PR and deletes the run's branches. The `e2e-worker-ready` label is shared configuration and is left in place.
- Run: `bun run --filter @devintern/e2e test:e2e:tracker` (runs with `github-tracker.test.ts`).
- Prerequisites: `E2E_TRACKER_REPOSITORY` and `E2E_TRACKER_TOKEN` (see the README). About 50 s.
