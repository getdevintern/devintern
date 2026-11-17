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

## Tracker plan status

### Asana

- Default `test`: yes (offline fake)
- Opt-in suite: none
- Notes: Fake lifecycle: key/`--query`, section transition, comment, decoy isolation. Worker polling through the Events API (412 handshake, sync-token rotation, expiry resync) is offline.
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
