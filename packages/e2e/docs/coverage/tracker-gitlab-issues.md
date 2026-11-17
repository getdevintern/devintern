# GitLab Issues tracker e2e coverage

Scope: local GitLab and GitLab.com Issues as the task tracker. Live run setup is in the [README](../../README.md#remote-tracker-fixtures).

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Local GitLab Issues: key and `--query`, status labels, comment, decoy

- Surface: External dependency: task trackers
- Status: `live`
- Evidence: `tests/code/gitlab-tracker.test.ts`
- Missing: Issue URL forms, estimation.
- Last reviewed: 2026-11-17

### GitLab.com Issues: key and `--query`

- Surface: External dependency: task trackers
- Status: `live`
- Evidence: `tests/code/gitlab-com-tracker.test.ts`
- Missing: Estimation, reopen/closed handling.
- Last reviewed: 2026-11-17

## Tracker plan status

### Local GitLab Issues

- Default `test`: no
- Opt-in suite: `test:e2e:tracker:gitlab`
- Notes: Existing live suite; creates and deletes a dedicated project.
- Last reviewed: 2026-11-17

### GitLab.com Issues

- Default `test`: no
- Opt-in suite: `test:e2e:tracker:gitlab-com`
- Notes: Existing live suite; pre-created project, issues only, project retained.
- Last reviewed: 2026-11-17
