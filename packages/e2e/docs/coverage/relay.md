# Relay e2e coverage

Scope: the hosted relay: GitLab relay delivery, relay instant events, tracker `task.changed` delivery, and `worker connect` relay targets.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### GitLab relay: delivery, MR-close unwatch, `--disconnect`

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `live`
- Evidence: `tests/code/gitlab-relay.test.ts`
- Missing: GitHub relay delivery. Offline tracker `task.changed` delivery is covered in the worker surface (`tests/local/worker-relay-task-events.test.ts`).
- Last reviewed: 2026-11-17

### `worker connect` relay targets (`github`, `gitlab`, `linear`, `asana`, `trello`, `azure-devops`, `jira`, `status`)

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `gap`
- Evidence: `gitlab` only: `tests/code/gitlab-relay.test.ts` (`live`)
- Missing: Needs a signed-in relay session (`devintern worker login`); `status` exits "Not authenticated" without one, so there is no loopback-only path.
- Last reviewed: 2026-11-17

### Relay instant events

- Surface: `devintern worker` surface
- Status: `live`
- Evidence: GitLab relay suite (`tests/code/gitlab-relay.test.ts`)
- Missing: GitHub relay PR events (`pr.review_submitted`, `pr.comment_created`).
- Last reviewed: 2026-11-17

### Relay tracker `task.changed` delivery: query gate, cursor resume, `deliveryId` dedupe, outage backoff, bearer auth

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-relay-task-events.test.ts` (fake Linear + loopback relay; `bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`)
- Missing: New `deliveryId` for an unchanged task and relay/poll-sweep dedupe (both need the post-PR actioned marker, and the bare remote opens no PR); real tracker webhooks into the hosted relay.
- Last reviewed: 2026-11-17

## Test notes

### Relay `task.changed` delivery (offline)

`tests/local/worker-relay-task-events.test.ts` starts one real
`devintern worker` with fake Linear (`providers/fake-linear.ts`) as the tracker
and a loopback relay fake (`helpers/fake-relay.ts`) in place of the hosted
control plane. No relay account, Supabase session, Linear workspace, or network
access is required, and `worker connect` is never run. The test writes a fake
pairing into `<workspace>/state/code/relay.json` (`relayUrl`, `customerId`, and
a synthetic `drt_e2e…` token) and points `WORKER_RELAY_URL` at the fake.

The fake implements `GET /v1/events?cursor=<n>`: it returns buffered envelopes
with a `seq` above the cursor, holds empty long polls for up to a second, and
can answer the next N polls with a scripted 5xx. Its request log keeps the
cursor and a bearer-token-matched boolean, never the header value.

`[defaults].task_query` is a Linear title filter and `poll_interval = 3600`, so
Mode 1 polling only runs its startup tick. That tick finishes before the
eligible issue exists, so the relay is what triggers the run. The test proves:

- a `task.changed` envelope for the eligible issue produces exactly one
  implementation run (pushed `feature/<key>` branch, Linear state moved to In
  Progress, one implementation comment), and an envelope for a decoy that does
  not match `task_query` produces no run, branch, comment, or state change;
- the cursor advances to the last `seq`, and replaying the same `deliveryId`
  under a new `seq` does not run the task again;
- after a graceful restart, the first poll carries the persisted cursor (never
  `0`). That poll gets a scripted 503: the worker logs the 5s backoff, keeps
  running, retries with the same cursor, and then consumes a later envelope;
- every poll carried the bearer token, and neither it nor the fake Linear key
  appears in worker output.

Linear workflow states are committed to the fixture repo's base branch as
`.devintern-code/settings.json`, because the task child reads settings from
its worktree.

Not covered: GitHub relay PR events (`pr.review_submitted`,
`pr.comment_created`); a new `deliveryId` for an unchanged task; and a later
poll sweep re-evaluating a task the relay already ran. Those last two rely on
the actioned marker, which is written only after a PR is created, and the local
bare remote exposes no code host.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### GitLab relay (live)

The separate opt-in `test:e2e:gitlab-relay` suite uses the **deployed** relay.
It installs a real managed project hook, proves review feedback arrives with
normal polling effectively disabled, verifies MR-close unwatching, and checks
that `--disconnect` removes the managed hook and stops deliveries. It needs a
signed-in Supabase session (`E2E_RELAY_AUTH_SESSION`, or the local
`~/.devintern/state/code/.auth-session.json`), an entitled account, and the
local GitLab container. It writes a temporary hook and relay route, then removes
both in cleanup. Run it with:

```sh
bun run --filter @devintern/e2e test:e2e:gitlab-relay
```

CI must provide `E2E_RELAY_AUTH_SESSION` explicitly; the suite is not part of
PR CI.
