# Jira tracker e2e coverage

Scope: Jira Cloud: the offline fake lifecycle, story-point estimation (one-shot and scheduled), the read-only smoke, and the planned Layer 2 live lifecycle.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Jira: offline fake key/`--query`, transition, comment, `--skip-comments`

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-jira-fake.test.ts`, `bun run --filter @devintern/e2e test`
- Missing: Real Jira project lifecycle, issue create/close, estimation, live `--skip-comments` semantics.
- Last reviewed: 2026-11-17

### Jira: live auth, project access, statuses, create metadata, JQL search

- Surface: External dependency: task trackers
- Status: `partial`
- Evidence: `test:trackers` read-only smoke
- Missing: Full live create/transition/comment/close lifecycle; estimation.
- Last reviewed: 2026-11-17

### Jira story-point estimation and unchanged-task skip

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-jira-estimation.test.ts`
- Missing: Live project field behavior.
- Last reviewed: 2026-11-17

### Offline fake Jira server (default lifecycle)

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-jira-fake.test.ts`, `bun run --filter @devintern/e2e test`
- Missing: Real Jira create/close and estimation.
- Last reviewed: 2026-11-17

### Jira tracker polling: `updated >=` detector + `task_query`, `(key, updated)` dedupe, no-PR actioned marker, re-arm on edit, retry gate, cursor resume

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-jira-polling.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Live Jira `updated` semantics. The PR-created actioned marker and post-PR transition are covered by the next row.
- Last reviewed: 2026-11-28

### Jira worker: polled ticket opens an MR, moves to the review status, and is skipped as PR-actioned

- Gap id: `e2e-tracker-jira-post-pr-actioned`
- Surface: `devintern worker` surface; external dependencies: Jira transitions/comments and GitLab MR creation
- Status: `default`
- Evidence: `tests/local/worker-jira-gitlab-pr.test.ts` (`bun run --filter @devintern/e2e test`), against `providers/fake-jira.ts` and `helpers/fake-gitlab-forge.ts` (`mergeRequestCreation`)
- Missing: Live Jira and a live GitLab instance. The existing-MR fallback (409, then the open-MR lookup and the label update) is served by the fake but not reached by the worker flow, because the re-run pushes a fresh branch. GitHub and Bitbucket hosts are not exercised for this workflow.
- Observed (unconfirmed intent): The Jira implementation comment is posted before the MR is created, so no Jira comment carries the MR URL. The URL is only on the run record and `agent_prs`. Not asserted.
- Observed (unconfirmed intent): After a description edit re-arms the PR'd ticket, the re-run creates `feature/<key>-attempt-2` and opens a second MR, and the first MR stays open. This matches the fresh-attempt rule in `docs/code/delegation-runs.md` (the open-PR check works only on GitHub), but the tracker docs say only that an edit re-arms the ticket. The test asserts the re-run, that no two MRs share a source branch, and that the first MR is unchanged. It does not assert the MR count after the re-run.
- Last reviewed: 2026-11-28

### Jira worker dependency gate: "is blocked by" links hold a polled ticket until the blocker is done

- Surface: External dependency: Jira dependency links
- Status: `default`
- Evidence: `tests/local/worker-jira-dependencies.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Live Jira `issuelinks` payloads and custom link types. Only the built-in "Blocks" and "Relates" types are modelled. The re-check backoff past the first few waits (up to 15 minutes) is not observed, because the test edits the dependent to re-check it.
- Last reviewed: 2026-11-21

### Jira blocker read failure fails closed

- Surface: External dependency: Jira dependency links
- Status: `default`
- Evidence: `tests/local/worker-jira-dependencies.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Failures other than HTTP 500, such as timeouts, 401/403, or a malformed body. The test sets `DEVINTERN_FETCH_MAX_RETRIES=0`, so the retry path before the gate fails closed is not exercised.
- Last reviewed: 2026-11-21

### Jira blocker implemented by this worker releases its dependent

- Surface: External dependency: Jira dependency links
- Status: `default`
- Evidence: `tests/local/worker-jira-dependencies.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Merged and stacked modes with a real PR (the bare remote has no code host, so the blocker is satisfied as `no-pr`). The failing blocker is an `escalated` run (`E2E_INCOMPLETE_PROMPT_MARKER`). Under the worker, `E2E_FAIL_PROMPT_MARKER` exits before any output, which counts as a harness that could not start: the ticket is deferred and retried every 60s and never settles a failed run, so a `failed` blocker status is not covered.
- Last reviewed: 2026-11-21

## Tracker plan status

### Jira

- Default `test`: yes (offline fake)
- Opt-in suite: `test:trackers` (read-only live smoke)
- Notes: Fake lifecycle: key/`--query`, transition, comment, `--skip-comments`. One-shot and scheduled worker estimation and worker polling are offline. Real project lifecycle and live estimation remain Layer 2.
- Last reviewed: 2026-11-17

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 1: ~~Offline fake Jira server with the lifecycle assertions from Layer 2~~ (implemented by `tests/local/tracker-jira-fake.test.ts`).
- Priority 3: Jira lifecycle against a dedicated fixture project (Layer 2), when that project and token exist.

## Layer 2 plan (live fixture project)

### Layer 2 fixture variables

Required variables (exact names open for review); see the shared rules in
[trackers.md](trackers.md#fixture-configuration).

| Variable                      | Meaning                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `E2E_JIRA_PROJECT_KEY`        | Dedicated Jira project that hosts test issues.          |
| `E2E_JIRA_ISSUE_TYPE`         | Issue type for test issues (default `Task`).            |
| `E2E_JIRA_TODO_STATUS`        | Initial workflow status (default `To Do`).              |
| `E2E_JIRA_IN_PROGRESS_STATUS` | In-progress status (default `In Progress`).             |
| `E2E_JIRA_REVIEW_STATUS`      | Status applied after PR creation (default `In Review`). |

### Jira specifics

- Create issues through the REST API with a unique marker in the description
  and a decoy outside the selector, mirroring the existing scenario.
- Apply labels for the unrelated seed label; statuses are workflow transitions,
  not labels.
- Verify the configured statuses exist before creating anything.
- Cleanup: delete seeded comments, then delete scenario-owned issues (the
  account needs `DELETE_ISSUES`; it is available on the reference account) or
  transition them to Done when deletion is intentionally disabled.
- Avoid the production `DEV` project by default. A dedicated `E2E` project is
  preferred; using `DEV` with hard deletion is a fallback only.

## Layer 3 fake (implemented)

`providers/fake-jira.ts` serves a strict Jira Cloud REST v3 subset on
`127.0.0.1:0` and owns all issues, comments, labels, statuses, and custom fields
in memory. `tests/local/tracker-jira-fake.test.ts` seeds an expected issue plus
a decoy outside the selector, writes per-project Jira statuses into
`.devintern-code/settings.json`, and runs the production Jira client through the
built CLI for both explicit-key and `--query` selection. It reads state back
through the fixture rather than CLI stdout.

`tests/local/tracker-jira-estimation.test.ts` adds the `--estimate` workflow.
Settings name `storyPointsField: "customfield_10016"` explicitly, so the test
covers the write/comment path without conflating it with field discovery. The
fake persists custom fields on `PUT /rest/api/3/issue/{key}` and exposes them
for assertions; it also implements `PUT /rest/api/3/issue/{key}/comment/{id}`
for in-place re-estimation and a deterministic clock control for the <24h skip.
Scenarios assert the story-point value, the single estimation comment (created
then updated by id, with the rewritten body carrying the new points),
`estimation-result.json`, and the skip behavior for unchanged and recent
issues. `--skip-comments` proves the field-only path and that a repeated sweep
stays a no-op without a comment to anchor the re-estimation gate. No branch,
commit, or push is created.

`tests/local/worker-scheduled-estimation.test.ts` starts the built worker with
`[[estimations]]` against the same fake. The workspace keeps the isolated bare
remote and deterministic agent. One enabled `15m` entry selects an issue older
than 24 hours; a same-query issue created at the fake's current clock is
selected and age-skipped; a disabled entry that would match a decoy is not
scheduled. The test does not wait out the interval. It lets the worker register
a future cursor, stops it, moves that cursor into the past, and starts again so
the startup tick claims one coalesced occurrence. The fake records the JQL. The
sweep writes story points and one estimation comment, the agent runs in estimate
mode, and the run record has origin `estimate` plus the schedule id. No branch,
pull request, or commit is created. A second driven occurrence runs the sweep
again and does not estimate the unchanged issue. No live tracker or credential
is required. The only skip is the built-CLI guard.

`tests/local/worker-jira-polling.test.ts` drives the worker's polling loop
(`[defaults].task_query`, `poll_interval = 1`) against the same fake. The fake
evaluates a documented JQL subset: clauses split on top-level `AND`, outer
parentheses stripped, `updated >= "-Nm"` against each issue's `updated` stamp
relative to the wall clock, and quoted text terms as before. The test covers
single pickup of the matching issue (branch, run record, comment, transition),
a decoy that is never run, no re-run while the issue is unchanged (the no-PR
actioned marker), exactly one re-run after a description edit, the retry gate
after an incomplete run (unlocked by exactly one human comment), and cursor
resume after a graceful restart. The PR-created actioned marker and post-PR
transition are covered offline by `tests/local/worker-jira-gitlab-pr.test.ts`
through the fake GitLab forge.

Endpoints covered:

- `GET /rest/api/3/myself`
- `GET /rest/api/3/search/jql` (enhanced JQL, requested issue fields)
- `GET /rest/api/3/issue/{key}` (including `?expand=renderedFields`)
- `GET /rest/api/3/issue/{key}/comment` (including `?expand=renderedBody`)
- `POST /rest/api/3/issue/{key}/comment` (ADF or text)
- `PUT /rest/api/3/issue/{key}/comment/{id}` (ADF or text)
- `GET` / `POST /rest/api/3/issue/{key}/transitions`
- `PUT /rest/api/3/issue/{key}` (labels, description, and custom fields)

Any other route returns a diagnostic 404 naming the method and path, and the
test asserts no unexpected request occurred. The fake accepts any Basic-auth
credentials, never logs them, and makes no outbound requests. Lifecycle
scenarios assert the pushed `feature/<key>` branch and exact
`src/greeting.ts` diff, the run record, the configured workflow status,
surviving unrelated labels, the implementation comment, and `--skip-comments`
on a second run. The local bare Git remote is the code host; no PR, GitHub
token, or model credentials are required. The only skip is the existing
built-CLI guard.

## Test notes

### Jira fake

The fake binds `127.0.0.1:0`, accepts any Basic-auth credentials (and never logs
them), and implements only the endpoints the product calls: `/myself`, enhanced
JQL `search/jql`, issue read/update (including custom fields), comments (ADF and
text, create and update), and workflow transitions. Any unmatched request
returns a diagnostic 404 and fails the test, so a client change that starts
calling a new route is visible instead of silently returning `{}`.

The Jira fake covers `/myself`, enhanced JQL `search/jql`, issue read/update,
comments (ADF and text), and workflow transitions.

The Jira key scenario additionally
runs a second time with `--skip-comments` to prove no additional comment or
transition is posted.

`tests/local/tracker-jira-estimation.test.ts` covers the `--estimate` workflow
against the same fake. Project settings configure `storyPointsField:
"customfield_10016"` explicitly so discovery drift is not conflated with the
write path. The deterministic agent detects the bundled estimation prompt and
returns a Fibonacci value; the test reads the custom field, the single
estimation comment (create, then in-place update whose body carries the new
value), and `estimation-result.json` back from durable state. It also exercises
the <24h skip, the already-estimated-and-unchanged skip, and `--skip-comments`
field-only behavior with a repeated sweep proving it does not re-estimate.
Estimation runs are read-only: no branch, commit, or push reaches the local
bare remote. No extra prerequisites or credentials are needed.

### Jira story-point estimation

`tests/local/tracker-jira-estimation.test.ts` covers one-shot estimation, unchanged-task skips, re-estimation, and `--skip-comments` against the offline Jira fixture. `tests/local/worker-scheduled-estimation.test.ts` covers the same fake from a worker `[[estimations]]` schedule: one coalesced sweep, `estimate` run attribution, read-only git, and a later sweep that leaves the unchanged issue alone.

### Worker Jira polling

`tests/local/worker-jira-polling.test.ts` starts one real `devintern worker`
with `[defaults].tracker = "jira"`, `[defaults].task_query = 'text ~ "<run
marker>"'`, and `poll_interval = 1` against the in-process Jira fake
(`providers/fake-jira.ts`, created with `wallClock: true` so tracker stamps
follow the real clock that the detector window and retry gate compare with).
It needs no Jira project, token, or network access. Build the CLI first. The
test skips only when `packages/code/dist` is absent, and a skip is not a pass.

In one workflow it proves:

1. Pickup. The eligible issue is implemented once: its branch is pushed to the
   bare remote, a `succeeded` run record exists, the issue gets one
   implementation comment, and it moves to In Progress. A decoy outside the
   query is never touched. `tracker.searches` contains the user query and the
   detector's `updated >= "-Nm"` window (N >= 6).
2. No re-run while unchanged. Over several further ticks the issue is not run
   again. A bare remote has no code-host platform, so the run succeeds without
   a PR, and the worker records the actioned marker for it.
3. Re-arm on change. Editing the description on the fake runs it exactly once
   more.
4. Retry gate. A second issue whose agent reports incomplete
   (`E2E_INCOMPLETE_PROMPT_MARKER`) gets the "Implementation Incomplete"
   comment and moves back to To Do. Its bot comment and transition do not
   trigger a retry. One human comment unlocks exactly one retry.
5. Cursor persistence. After a graceful stop and restart on the same
   workspace, the first search is the detector window from the persisted
   cursor, and nothing already processed runs again.

```bash
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Worker Jira polling through a GitLab forge (PR path)

`tests/local/worker-jira-gitlab-pr.test.ts` runs the same polling loop as above,
but the repo remote is a loopback GitLab project. `FakeGitlabForge` with
`mergeRequestCreation` serves what `GitLabMRClient.createPullRequest` calls:
`GET /version`, the project with its default branch, branch reads from the bare
repository, `GET labels`, the open-MR lookup, `POST merge_requests` (409 while
an open MR uses the same source branch), and the label update on an existing MR.
A git `insteadOf` rewrite (`installForgeGitRewrite`) maps the forge URL onto the
bare repository. The Jira fake keeps distinct In Progress and In Review statuses,
so the post-PR transition is a separate step. Jira and GitLab tokens are random
per-test values, and a refusing recording proxy is set as `HTTP(S)_PROXY`.

It proves:

1. PR path. The polled ticket gets exactly one MR from `feature/<key>` to the
   default branch, carrying only the project label that exists (the missing
   `pr_labels` entry is skipped with a warning). The branch tip has the agent's
   change. Jira sees the transitions In Progress, then In Review, and one
   implementation comment. The run record's `pr_url` and the `agent_prs` row are
   the MR URL. The actioned marker is the PR-created one (`transitioned = 1`,
   `transition_status = In Review`), not the no-PR one.
2. PR-actioned dedupe. Later ticks log
   `skipping <key> (already actioned; no change since the PR)`. There is no
   second run, MR request, or comment.
3. Re-arm. A description edit runs the ticket exactly once more, with no MR
   opened twice from one source branch. The first MR is unchanged, the re-run's
   `pr_url` is a forge MR, and the ticket ends PR-actioned in In Review again.
4. Hygiene. The forge has no unexpected requests or auth failures, the Jira fake
   has no unexpected requests, and the proxy saw nothing. Neither token, raw or
   URL-encoded, appears in worker output, posted bodies, or files under the
   fixture root.

Prerequisites: none beyond the built CLI.

```bash
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Worker Jira dependency gate

`tests/local/worker-jira-dependencies.test.ts` starts a real `devintern worker`
against the in-process Jira fake (`wallClock: true`, `poll_interval = 1`). The
fake returns `fields.issuelinks` in Jira Cloud's shape: each link names the
other issue as `inwardIssue` or `outwardIssue`, and that issue carries its
status and status category. `linkIssues` creates links,
`failBlockerReads` makes `GET /issue/{key}?fields=issuelinks` return HTTP 500,
and `blockerReads` records each gate read. The test reads held-back tickets
through `devintern worker queue --json --workspace <path>`. Three tests:

1. Dependency gate. DEP is blocked by BLK, an open issue outside the query.
   DEP is listed as a `tracker` item with `dependencyState: "waiting"`,
   `dependsOn` containing BLK, and a reason naming BLK. Over several gate
   evaluations it gets no run, agent call, transition, comment, or branch.
   A ticket with only a "Relates" link and an outward "blocks" link to the
   same open BLK runs normally. Moving BLK to Done and editing DEP runs DEP
   exactly once.
2. Fail closed. While blocker reads return 500, DEP waits with
   `could not read <key>'s blockers from jira: …` and is not started. Once
   reads recover and DEP is edited, it runs once.
3. Blocker implemented here. BLK and DEP both match the query. BLK runs first
   and succeeds without a PR, and DEP starts after BLK's run finished
   (`started_at >= finished_at`) while Jira still reports BLK In Progress. A
   second blocker that reports incomplete (`escalated`) leaves its dependent
   `blocked` and never started.

Prerequisites: none beyond the built CLI.

```bash
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```
