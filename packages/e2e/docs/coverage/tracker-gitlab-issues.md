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

### GitLab Issues worker: offline polling, status labels, and is_blocked_by dependency gate

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/worker-gitlab-issues-dependencies.test.ts`, `providers/fake-gitlab-issues.ts`
- Missing: Real Premium blocking links on a live instance (the fake stands in for `GET /projects/:id/issues/:iid/links`); blocker read failures (HTTP 5xx, fail-closed wait); `merged`/`stacked` modes for a blocker the worker implemented; numeric `GITLAB_PROJECT` ids; `assignee:@me` and free-text `search` queries in worker mode.
- Last reviewed: 2026-11-22

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

## Test notes

`tests/local/worker-gitlab-issues-dependencies.test.ts` runs in the default offline suite and needs no GitLab account, token, or container:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

`providers/fake-gitlab-issues.ts` is a loopback GitLab REST v4 stand-in (`127.0.0.1:0`) that serves only the issue endpoints the worker calls: issue list (`state`, `labels`, `search`, `updated_after`, `X-Total`), single issue get/update (`add_labels`, `remove_labels`, `state_event`), project labels, notes, issue links, and `/user`. It checks `PRIVATE-TOKEN` against a random per-run token (401 otherwise), answers any other route or project with 404, and records method, path, and status only.

Scenarios:

1. Polling: with `task_query = "is:open label:e2e-todo"` and `poll_interval = 1`, the ready issue runs once: branch on the bare remote, a succeeded run record, `e2e-todo` swapped for `e2e-in-progress` (a non-status label survives), and one implementation comment. An unlabelled open decoy and a closed labelled decoy are never written to, and later ticks do not re-run the issue.
2. Dependency gate: the ready issue `is_blocked_by` an open same-project issue (keyed by iid) and an open cross-project issue (keyed `group/project#iid`), and also has `relates_to` and `blocks` links to open issues. Across several link reads it gets no label change, comment, or branch, and `worker queue --json` lists it as a waiting `tracker` item with both blockers in `dependsOn`. Closing the same-project blocker leaves it waiting on the cross-project one; closing that too runs it exactly once. Each release bumps the dependent's `updated_at` instead of waiting out the gate's backoff.
