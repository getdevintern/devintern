# Asana tracker e2e coverage

Scope: Asana: the offline fake lifecycle and worker polling through the Events API.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Asana: offline fake key/`--query`, section transition, comment, decoy, Events API

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-asana-fake.test.ts`, `tests/local/worker-asana-polling.test.ts`
- Missing: Live project lifecycle.
- Last reviewed: 2026-11-17

### Asana polling via Events API sync tokens: 412 handshake, token rotation, edit re-run, expired-token resync, `(key, updated)` dedupe, no self-loop, missing project GID

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-asana-polling.test.ts` (`bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`)
- Missing: PR-actioned gate for Asana (bare remote creates no PR); live Asana Events API; multi-team Asana sources.
- Last reviewed: 2026-11-17

### Asana: comment-only --estimate and re-estimation

- Surface: CLI `--estimate` against external dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-asana-estimation.test.ts` (`bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`)
- Missing: Live Asana stories API. The 24-hour new-task skip is covered by the scheduled sweep row below; the numeric custom-field write by the story-points row.
- Last reviewed: 2026-11-19

### Asana: scheduled `[[estimations]]` sweep (gap `e2e-tracker-asana-scheduled-estimation`)

- Surface: `devintern worker` surface: `[[estimations]]` against external dependency: task trackers
- Status: `default`
- Evidence: `tests/local/worker-asana-scheduled-estimation.test.ts` (`bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`)
- Missing: Live Asana project; team-scoped Asana estimations; dashboard "Run now" for an Asana estimation; re-estimation of an edited task through the worker (the CLI test covers it).
- Last reviewed: 2026-11-19

### Asana: story points to a numeric custom field (gap `e2e-tracker-asana-story-points-field`)

- Surface: CLI `--estimate` against external dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-asana-estimation.test.ts` (`bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`)
- Missing: `storyPointsField` from `.devintern-code/settings.json` for Asana (the product looks it up by the task GID's prefix, not the project GID); live Asana custom fields API.
- Last reviewed: 2026-11-19

## Tracker plan status

### Asana

- Default `test`: yes (offline fake)
- Opt-in suite: none
- Notes: Fake lifecycle: key/`--query`, section transition, comment, decoy isolation. Comment-only `--estimate` with in-place story re-estimation, and the number custom-field write. Worker polling through the Events API (412 handshake, sync-token rotation, expiry resync) and the scheduled `[[estimations]]` sweep are offline.
- Last reviewed: 2026-11-19

## Layer 3 fake (implemented)

`tests/local/worker-asana-polling.test.ts` drives worker polling against the
Asana fake's Events API (`GET /api/1.0/events?resource=&sync=`). A missing or
expired token returns 412 with a fresh `sync`, and a live token returns the
events since it was issued plus a rotated `sync`. Fake writes append events, and
a test hook expires every token. The test covers the 412 first-tick drain, the
rotated-token chain on empty pages (no evaluate, no run), an edit-triggered
single run, expired-token full resync without re-runs, the `(key, updated)`
dedupe for an unchanged still-matching task, and the startup refusal without
`ASANA_DEFAULT_PROJECT_GID`.

## Test notes

### Asana fake

`tests/local/tracker-asana-fake.test.ts` exercises the built CLI against a loopback Asana API fixture, covering key and query selection, project sections, comments, and decoy isolation.

### Worker Asana polling (Events API)

`tests/local/worker-asana-polling.test.ts` starts the built `devintern worker` with `tracker = "asana"`, a `section:"To Do" <marker>` `task_query`, and `poll_interval = 1` against the same fake. The fake implements `GET /api/1.0/events?resource=<project>&sync=<token>` with Asana's sync semantics: a missing, unknown, or expired token returns 412 with a fresh `sync` and an `errors` array; a live token returns the events since it was issued plus a rotated `sync`. Task create/update/section moves and story add/edit/delete append events, `expireSyncTokens()` invalidates every outstanding token, and `syncRequests` records the received and issued tokens (sync cursors, not credentials) and whether the Bearer token matched.

The suite proves the first tick's 412 handshake runs the eligible task once and leaves the decoy alone. Later ticks present the rotated token, and empty pages cause no evaluate query and no run. A human edit generates an event and exactly one more run. The worker's own section move and implementation comment do produce events and a re-evaluation, but the query no longer matches once the task leaves To Do, so there is no self-loop. An expired token gets a 412 mid-run, triggers a full re-evaluation, and the worker recovers on the new token without crashing. With `--skip-comments` the processed task still matches unchanged, and the `(key, updated)` dedupe skips it on that full resync. Without `ASANA_DEFAULT_PROJECT_GID` the worker refuses to start and never calls the Events API. Build the CLI first; the only skip is the built-CLI guard.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Asana comment-only estimation

`tests/local/tracker-asana-estimation.test.ts` runs the built `devintern <gid> --estimate` against the same fake, with the deterministic agent in `estimate` mode and no `storyPointsField`/`ASANA_STORY_POINTS_FIELD`, so `discoverEstimationField` returns null without an API call and the CLI prints `No story points field found — skipping field update`. It reads results back from the fake's state and request log, not from CLI stdout.

- First run: exit 0, one `estimate` run record (`succeeded`, no PR), exactly one `POST /api/1.0/tasks/{gid}/stories` story carrying the `Automated Story Points Estimation` marker and the points, `estimation-result.json` in the output directory, and no `PUT /api/1.0/tasks/{gid}` (no field write).
- Unchanged task: skipped through the durable baseline (`lib/state/estimation-state.ts`), with no agent run and no new run record.
- Changed task (`editTicket` bumps `modified_at`): re-estimates and rewrites the same story through exactly one `PUT /api/1.0/stories/{gid}`. There is still one story, now with the new points and without the old ones. A following sweep skips, because the story edit is the estimation's own write.
- `--skip-comments`: Asana has neither a field nor a comment to write, so the product classifies the attempt as `Estimation wrote nothing to the tracker`. The CLI exits 1 and records a `failed` run. `estimation-result.json` is still saved, and no story or task write reaches the fake. The retry marker makes the next sweep run the agent again, which also fails.
- Every case: no branch, commit, or push on the local bare remote, and no unexpected fake route.

The shared markdown-to-Asana HTML converter renders the `Story Points | Confidence` line as a `<pre>` block, so the story keeps literal `**` markers around `Story Points:`. The test matches the points with or without that markup. The fake already persists `text`/`html_text` on story updates, and the product reads only `created_at` as a fallback timestamp, so the fake needed no changes. Build the CLI first; the only skip is the built-CLI guard.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Asana story points custom field

The third test in `tests/local/tracker-asana-estimation.test.ts` sets `ASANA_STORY_POINTS_FIELD=story points` and seeds one task with a number custom field named `Story Points` (plus an unrelated enum field), and a second task with a same-named text field. On the first task, `--estimate` writes the points with exactly one `PUT /api/1.0/tasks/{gid}` to that field's GID and posts one estimation story. An unchanged rerun is skipped even though the field write bumped `modified_at`. After a human edit the same field and the same story carry the new points. On the second task the text field is ignored: the CLI prints `No story points field found` and only posts the story.

The fake accepts `customFields` on `createTicket` and exposes `customField(key, name)`. Like real Asana, it rejects with a 400 diagnostic a write to a field the task does not carry, a write to a non-number field, or a non-number value. Build the CLI first; the only skip is the built-CLI guard.

### Worker Asana scheduled estimation

`tests/local/worker-asana-scheduled-estimation.test.ts` starts the built `devintern worker` with `tracker = "asana"`, the fake's environment, and one enabled `[[estimations]]` entry (`interval = "15m"`, `query = 'section:"To Do" <selector>'`). The fake seeds two old tasks whose names carry the selector, a decoy in the same section that mentions the selector only in its notes (Asana's text filter matches names), and a selector task created "now" through the fake's new `setNow` clock control.

- Registration: the first start records a future `estimation:<id>` cursor and makes no Asana request.
- First due sweep (cursor moved into the past while the worker is stopped): one scheduled run, one `GET /projects/{gid}/tasks` listing, and two run records (one per old task) with origin `estimate`, the estimation id, `succeeded`, and no branch, repo, or PR. The deterministic agent runs twice in `estimate` mode. Each old task gets exactly one estimation story and an `estimation-result.json`, and the only tracker writes are those two story posts. The new task is selected and skipped (`< 24h`), and the decoy is never touched.
- Second due sweep: Asana is listed again, both old tasks are skipped as `already estimated and not updated since`, and there are no new agent calls, run records, or tracker writes.
- Every phase: the bare remote and seed checkout stay at the fixture commit, no task worktree exists, and the fake saw no unexpected route.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```
