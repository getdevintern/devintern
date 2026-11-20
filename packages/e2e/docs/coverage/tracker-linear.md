# Linear tracker e2e coverage

Scope: Linear: the offline GraphQL fake lifecycle and worker polling through `updatedAt` deltas. Relay `task.changed` delivery against the same fake lives in [relay.md](relay.md).

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Linear: offline fake key/`--query`, workflow state, comment, decoy isolation

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-linear-fake.test.ts`, `bun run --filter @devintern/e2e test`
- Missing: Live team/project lifecycle, live estimation, attachment uploads.
- Last reviewed: 2026-11-18

### Offline fake Linear server (default lifecycle)

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-linear-fake.test.ts`, `bun run --filter @devintern/e2e test`
- Missing: Live team/project lifecycle, live estimation, attachment uploads.
- Last reviewed: 2026-11-18

### Linear worker polling: `updatedAt.gt` delta, pickup, `(key, updated)` dedupe, re-arm, cursor restart

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-linear-polling.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Live Linear filter semantics; actioned-PR gate (no PR on a bare remote).
- Last reviewed: 2026-11-17

### Linear: `--estimate` native estimate field, estimation comment, re-estimation

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-linear-estimation.test.ts`, `bun run --filter @devintern/e2e test`
- Missing: Live Linear estimation (team estimate scales, real `IssueUpdateInput`/`CommentUpdateInput` validation); the worker `[[estimations]]` schedule is covered by [Linear: scheduled `[[estimations]]` sweep](#linear-scheduled-estimations-sweep-gap-e2e-tracker-linear-scheduled-estimation).
- Last reviewed: 2026-11-20

### Linear: scheduled `[[estimations]]` sweep (gap `e2e-tracker-linear-scheduled-estimation`)

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-linear-scheduled-estimation.test.ts`, `bun run --filter @devintern/e2e test`
- Missing: Live Linear estimation (team estimate scales, real `IssueFilter` and `IssueUpdateInput.estimate` validation); cron-expression schedules for a Linear entry (interval only).
- Last reviewed: 2026-11-20

## Tracker plan status

### Linear

- Default `test`: yes (offline fake)
- Opt-in suite: none
- Notes: Fake lifecycle: key/`--query`, workflow state, comment, decoy isolation. Worker polling, relay `task.changed` delivery, CLI `--estimate`, and the scheduled `[[estimations]]` sweep are offline too. Live Layer 2 team/project lifecycle, live estimation, and attachments remain future work.
- Last reviewed: 2026-11-20

## Layer 3 fake (implemented)

`providers/fake-linear.ts` serves a strict Linear GraphQL subset on
`127.0.0.1:0` and owns one team, its workflow states, issues, labels, and
markdown comments in memory. `tests/local/tracker-linear-fake.test.ts` seeds an
expected issue plus a decoy outside the selector, writes per-team statuses into
`.devintern-code/settings.json`, and runs the production Linear client through
the built CLI for both explicit-key and JSON IssueFilter `--query` selection.
State is read back through the fixture rather than CLI stdout. The fixture sets
`TASK_TRACKER=linear`, a synthetic `LINEAR_API_KEY`, and
`LINEAR_API_URL=http://127.0.0.1:<port>/graphql`.

Operations covered:

- `IssueById` (identifier/UUID lookup with the full issue-detail field set)
- `IssueComments` (markdown bodies, fixed advancing timestamps)
- `TeamStates` (workflow state ids and names)
- `CommentCreate` (markdown comment bodies)
- `CommentUpdate` (`input.body` only; rewrites the comment in place, keeps
  its id and `createdAt`, and advances its and the issue's `updatedAt`)
- `IssueUpdate` (`stateId`, plus `estimate`/`labelIds`/title/description fields)
- `SearchIssues` (JSON IssueFilter with `title`/`description` string
  conditions, `state.name`/`team.key` equality, `updatedAt`
  `gt`/`gte`/`lt`/`lte` date bounds, and `and`/`or`, plus plain-text title
  contains); every request is recorded in `searchRequests`

`tests/local/worker-linear-polling.test.ts` drives the worker daemon against
the same fake (with `clock: "wall"` so `updatedAt` falls inside the detector's
real-time window). It pins the change detector's bare
`{"updatedAt":{"gt":"<cursor - 5m>"}}` request, status-query pickup and re-arm,
`(key, updatedAt)` dedupe for an unchanged ready issue, and reuse of the saved
cursor after a graceful restart on the same queue DB.

The fake also records answered operation names in `operations` (names only),
so a worker test can tell when a poll tick has already read its state.
`tests/local/worker-relay-task-events.test.ts` uses that to drive a worker
whose `task_query` is a JSON IssueFilter through the loopback relay fake
(`helpers/fake-relay.ts`); see [relay.md](relay.md).

Any other operation or malformed payload returns a diagnostic GraphQL error and
is recorded in `unexpectedOperations`, which both scenarios assert is empty.
Live Layer 2 coverage — real team/project lifecycle, live estimation, and attachment
uploads — remains future work; there is intentionally no live Linear suite.

## Test notes

### Offline fake Linear server

The same default suite also includes an in-process Linear GraphQL fake
(`providers/fake-linear.ts`), so the built CLI exercises the Linear tracker
lifecycle without a Linear workspace, token, or network access.
`tests/local/tracker-linear-fake.test.ts` skips only when the built CLI is
absent.

The fake binds `127.0.0.1:0` on a single `POST /graphql` endpoint, accepts any
`Authorization` header without logging it, and serves one in-memory team with
Todo/In Progress/In Review workflow states, issues, labels, and markdown
comments. It implements only the operations the product calls: `IssueById`,
`IssueComments`, `TeamStates`, `CommentCreate`, `CommentUpdate`, `IssueUpdate`, and
`SearchIssues` (filters on `title`/`description`, `state.name`, `team.key`,
and `updatedAt` comparators; anything else is rejected). Any other operation
or malformed payload returns a diagnostic GraphQL error and fails the test through `unexpectedOperations`.

The fixture supplies `TASK_TRACKER=linear`, a synthetic `LINEAR_API_KEY`, and
`LINEAR_API_URL=http://127.0.0.1:<port>/graphql`; no environment variable is
inherited. Two scenarios run the production Linear client through explicit-key
and JSON IssueFilter `--query` selection against a seeded issue and a decoy
outside the selector. Read-back goes through the fake fixture, not CLI stdout:
the pushed `feature/<key>` branch and exact `src/greeting.ts` diff, the run
record, the configured workflow state, surviving unrelated labels, the
implementation summary comment, delivery of the seeded description/comment
markers to the deterministic agent, and an untouched decoy. The local bare Git
remote is the code host; no PR, GitHub token, or model credentials are required.

### Linear worker polling

`tests/local/worker-linear-polling.test.ts` runs the built `devintern worker`
daemon with `tracker = "linear"`, a status-based JSON IssueFilter
`task_query` (team key plus the `Todo` state), `poll_interval = 1`, the
deterministic agent, and a local bare remote, against the same in-process
Linear fake (`LINEAR_API_URL` points at loopback; `NO_PROXY` covers loopback).
It records every `SearchIssues` request the fake receives and asserts:

- the first tick evaluates the user's query directly (no cursor yet), picks up
  the one ready issue, pushes `feature/<key>`, writes a run record and the
  implementation comment, and moves the issue to In Progress; a Backlog decoy
  is never touched;
- later ticks send the bare change-detector filter
  `{"updatedAt":{"gt":"<ISO>"}}`, whose bound is the previous tick's detection
  time minus the 5-minute `DELTA_LOOKBACK_MS`;
- idle polls start no run, moving a Backlog issue to `Todo` runs it exactly
  once, and after a graceful stop/start on the same queue DB the first request
  is the delta built from the saved cursor;
- with `--skip-comments` (no tracker writes) an unchanged ready issue keeps
  matching the query yet is skipped by the no-PR actioned marker across polls
  and the restart, and a human description edit (new `updatedAt`) runs it once
  more.

The fake runs with `clock: "wall"` so its `updatedAt` stamps fall inside the
detector's real-time window. No prerequisites beyond the built CLI; the test
skips when `packages/code/dist/index.js` is absent. Run it alone with
`bun test tests/local/worker-linear-polling.test.ts` from `packages/e2e`.

### Linear `--estimate`

`tests/local/tracker-linear-estimation.test.ts` runs the built
`devintern <key> --estimate` (and `--query <IssueFilter> --estimate`) against
the same in-process Linear fake with the deterministic agent in `estimate`
mode and a local bare remote. Linear estimation writes the native `estimate`
field (`IssueUpdate` with `input.estimate`), so no story-points settings are
needed. Read-back goes through the fake (`getEstimate`, `listComments`,
answered `operations`), not CLI stdout. It asserts:

- the issue's `estimate` equals the agent's points, exactly one comment
  carries the `Automated Story Points Estimation` marker,
  `estimation-result.json` is written, the run record has origin `estimate`,
  and a decoy issue is untouched;
- an unchanged issue is skipped without an agent attempt; after a human
  description edit (new `updatedAt`) the next run re-estimates and rewrites
  the same comment through exactly one `CommentUpdate` (same id, new body, new
  estimate), and a further no-change run is skipped (the estimation's own
  writes are not treated as a user change);
- an issue created less than 24 hours ago (fake `clock: "wall"`) is skipped:
  no agent call, no `IssueUpdate`, no comment, no run record;
- `--skip-comments` with `--query` selection writes the field without
  `CommentCreate`, and a repeat run is a no-op through the persisted
  estimation state;
- every scenario leaves the workspace on the base branch with a clean tree,
  pushes no `feature/<key>` branch to the bare remote, and records no
  unexpected GraphQL operation.

No prerequisites beyond the built CLI; the test skips only when
`packages/code/dist/index.js` is absent. Run it alone with
`bun test tests/local/tracker-linear-estimation.test.ts` from `packages/e2e`.

### Linear scheduled `[[estimations]]` sweep

`tests/local/worker-linear-scheduled-estimation.test.ts` runs the built
`devintern worker` daemon with `tracker = "linear"`, the deterministic agent
in `estimate` mode, a local bare remote, and one `[[estimations]]` entry
(`interval = "15m"`, `query` = a JSON IssueFilter on a per-run title marker)
against the in-process Linear fake. Instead of waiting out the interval, the
test stops the worker, moves the durable `estimation:<id>` schedule row into
the past, and starts it again. It asserts:

- the first start only registers the schedule (`interval:15m`, no run, no
  Linear request);
- a due sweep sends one `SearchIssues` with the configured filter, sets the
  native `estimate` and posts exactly one estimation comment on each of the two
  matching issues, records one `estimate`-origin run per issue attributed to
  the estimation id (no branch, repo, or PR), and advances the schedule
  cursor; a decoy with the marker only in its description is never selected,
  and a matching issue created "now" (fake `setNow`) is skipped as `< 24h`;
- a second due sweep with unchanged issues re-queries Linear but spawns no
  agent, writes nothing, and keeps each comment id;
- after a human edit to one issue, a third sweep re-estimates only that issue
  (one `IssueUpdate`, one `CommentUpdate` rewriting the same comment with the
  new points) and skips the other;
- the bare remote and seed checkout stay at the fixture commit, no task
  worktree is left behind, and no unexpected GraphQL operation is recorded.

No prerequisites beyond the built CLI; the test skips only when
`packages/code/dist/index.js` is absent. Run it alone with
`bun test tests/local/worker-linear-scheduled-estimation.test.ts` from
`packages/e2e`.
