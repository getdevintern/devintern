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

## Tracker plan status

### GitHub Issues

- Default `test`: no
- Opt-in suite: `test:e2e:tracker`
- Notes: Existing live suite; dedicated tracker repository doubles as code host.
- Last reviewed: 2026-11-17
