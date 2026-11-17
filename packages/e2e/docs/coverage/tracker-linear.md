# Linear tracker e2e coverage

Scope: Linear: the offline GraphQL fake lifecycle. Relay `task.changed` delivery against the same fake lives in [relay.md](relay.md).

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Linear: offline fake key/`--query`, workflow state, comment, decoy isolation

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-linear-fake.test.ts`, `bun run --filter @devintern/e2e test`
- Missing: Live team/project lifecycle, estimation, attachment uploads.
- Last reviewed: 2026-11-17

### Offline fake Linear server (default lifecycle)

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-linear-fake.test.ts`, `bun run --filter @devintern/e2e test`
- Missing: Live team/project lifecycle, estimation, attachment uploads.
- Last reviewed: 2026-11-17

## Tracker plan status

### Linear

- Default `test`: yes (offline fake)
- Opt-in suite: none
- Notes: Fake lifecycle: key/`--query`, workflow state, comment, decoy isolation. Worker relay `task.changed` delivery is offline too. Live Layer 2 team/project lifecycle, estimation, and attachments remain future work.
- Last reviewed: 2026-11-17

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
- `IssueUpdate` (`stateId`, plus `estimate`/`labelIds`/title/description fields)
- `SearchIssues` (JSON IssueFilter with `title`/`description` string
  conditions, `updatedAt` `gt`/`gte`/`lt`/`lte` date conditions (the worker
  change detector's delta query), and `and`/`or`, plus plain-text title
  contains)

The fake also records answered operation names in `operations` (names only),
so a worker test can tell when a poll tick has already read its state.
`tests/local/worker-relay-task-events.test.ts` uses that to drive a worker
whose `task_query` is a JSON IssueFilter through the loopback relay fake
(`helpers/fake-relay.ts`); see [relay.md](relay.md).

Any other operation or malformed payload returns a diagnostic GraphQL error and
is recorded in `unexpectedOperations`, which both scenarios assert is empty.
Live Layer 2 coverage — real team/project lifecycle, estimation, and attachment
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
`IssueComments`, `TeamStates`, `CommentCreate`, `IssueUpdate`, and
`SearchIssues`. Any other operation or malformed payload returns a diagnostic
GraphQL error and fails the test through `unexpectedOperations`.

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
