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
- Missing: Numeric custom-field write when `ASANA_STORY_POINTS_FIELD`/`storyPointsField` names a number field; the 24-hour new-task skip for Asana; worker `[[estimations]]` schedule against the Asana fake (gap `e2e-tracker-asana-scheduled-estimation`, not bundled; still a gap); live Asana stories API.
- Last reviewed: 2026-11-18

## Tracker plan status

### Asana

- Default `test`: yes (offline fake)
- Opt-in suite: none
- Notes: Fake lifecycle: key/`--query`, section transition, comment, decoy isolation. Comment-only `--estimate` with in-place story re-estimation. Worker polling through the Events API (412 handshake, sync-token rotation, expiry resync) is offline.
- Last reviewed: 2026-11-17

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
