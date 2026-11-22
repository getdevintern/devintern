# GitLab Issues tracker e2e coverage

Scope: local GitLab and GitLab.com Issues as the task tracker. Live run setup is in the [README](../../README.md#remote-tracker-fixtures).

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Local GitLab Issues: key and `--query`, status labels, comment, decoy

- Surface: External dependency: task trackers
- Status: `live`
- Evidence: `tests/code/gitlab-tracker.test.ts`
- Missing: Issue URL forms and estimation against a live instance (both covered offline below).
- Last reviewed: 2026-11-23

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
- Missing: Real Premium blocking links on a live instance (the fake stands in for `GET /projects/:id/issues/:iid/links`); blocker read failures are covered by the fail-closed row below; `merged`/`stacked` modes for a blocker the worker implemented; numeric `GITLAB_PROJECT` ids; `assignee:@me` and free-text `search` queries in worker mode.
- Last reviewed: 2026-11-22

### GitLab Issues: `--estimate` comment-only estimation (offline fake)

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-gitlab-issues-estimation.test.ts`, `providers/fake-gitlab-issues.ts`; run with `bun run --filter @devintern/e2e test`
- Missing: Estimation against a live GitLab instance; `--query` selection and `--skip-comments` with `--estimate`; scheduled `[[estimations]]` sweeps for GitLab; the run output states only that no story points field exists, the comment-only wording is in `--help`.
- Last reviewed: 2026-11-23

### GitLab Issues: issue URL task arguments (offline fake)

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-gitlab-issues-url-forms.test.ts`, `providers/fake-gitlab-issues.ts`; run with `bun run --filter @devintern/e2e test`
- Missing: Live-instance URLs. Limitation: only the iid is read from a URL. A URL whose host or project differs from `GITLAB_BASE_URL`/`GITLAB_PROJECT` runs the same-numbered issue of the configured project instead of being rejected (not asserted). `/-/work_items/<iid>` URLs are rejected as invalid references.
- Last reviewed: 2026-11-23

### GitLab Issues worker: blocker read failure holds the issue (fail-closed, offline fake)

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/worker-gitlab-issues-dependencies.test.ts` (failing blocker read scenario), `providers/fake-gitlab-issues.ts` (`failLinks`); run with `bun run --filter @devintern/e2e test`
- Missing: Network errors and timeouts on the links read (only HTTP 503 is injected); 404 from a GitLab Free instance on the links endpoint; a failing read on a live instance.
- Last reviewed: 2026-11-23

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

`tests/local/worker-gitlab-issues-dependencies.test.ts`, `tests/local/tracker-gitlab-issues-estimation.test.ts`, and `tests/local/tracker-gitlab-issues-url-forms.test.ts` run in the default offline suite and needs no GitLab account, token, or container:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

`providers/fake-gitlab-issues.ts` is a loopback GitLab REST v4 stand-in (`127.0.0.1:0`) that serves only the issue endpoints the worker calls: issue list (`state`, `labels`, `search`, `updated_after`, `X-Total`), single issue get/update (`add_labels`, `remove_labels`, `state_event`), project labels, notes, issue links, and `/user`. It checks `PRIVATE-TOKEN` against a random per-run token (401 otherwise), answers any other route or project with 404, and records method, path, and status only.

Scenarios:

1. Polling: with `task_query = "is:open label:e2e-todo"` and `poll_interval = 1`, the ready issue runs once: branch on the bare remote, a succeeded run record, `e2e-todo` swapped for `e2e-in-progress` (a non-status label survives), and one implementation comment. An unlabelled open decoy and a closed labelled decoy are never written to, and later ticks do not re-run the issue.
2. Dependency gate: the ready issue `is_blocked_by` an open same-project issue (keyed by iid) and an open cross-project issue (keyed `group/project#iid`), and also has `relates_to` and `blocks` links to open issues. Across several link reads it gets no label change, comment, or branch, and `worker queue --json` lists it as a waiting `tracker` item with both blockers in `dependsOn`. Closing the same-project blocker leaves it waiting on the cross-project one; closing that too runs it exactly once. Each release bumps the dependent's `updated_at` instead of waiting out the gate's backoff.
3. Blocker read failure: the ready issue's links read answers HTTP 503 on every call. Across several reads the issue gets no run, agent call, label change, note, or branch; `worker queue --json` lists it as `waiting` with no `dependsOn` and a reason naming the failed read, and the worker log records the wait. Once the fault is cleared (and `updated_at` bumped), it runs exactly once.

`tests/local/tracker-gitlab-issues-estimation.test.ts` runs one-shot `devintern <issue> --estimate` against the fake, with the issue backdated two days because the CLI skips issues created less than 24 hours ago. It proves:

- `--help` describes GitLab estimation as comment-only, and the run logs that no story points field was found.
- The first run posts exactly one estimation note on the selected issue and writes nothing else: title, description, labels, and state are unchanged. It records one `estimate` run, writes no branch or commit, and leaves the decoy untouched.
- A second run on the unchanged issue is skipped before the agent is called.
- After a human edit, the next run rewrites the same note in place (`PUT …/notes/:note_id`) with the new points, with no second note.

`tests/local/tracker-gitlab-issues-url-forms.test.ts` passes three issue URLs to one batch run: `<base>/<project>/-/issues/<iid>`, the legacy `<base>/<project>/issues/<iid>/` with a trailing slash, and `…/-/issues/<iid>?scope=all#note_…`. Each resolves to its own issue, the same as the bare iid. Each gets a run record keyed by the iid, a `feature/<iid>` branch, its own prompt, a status-label swap, and one implementation note. A decoy carrying the ready label is never written to. A `/-/work_items/<iid>` URL fails with `Invalid GitLab issue reference` and makes no writes or agent call.

All three files need only the built CLI. Each test owns a temporary root (HOME, workspace, state databases, output directory, and bare remote), a loopback fake on `127.0.0.1:0` with a random token, and the deterministic `helpers/fake-agent.ts`. All of it is removed in `finally`. The tests assert that the token never appears in CLI output or the worker log.
