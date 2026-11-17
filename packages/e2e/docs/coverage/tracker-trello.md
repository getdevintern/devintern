# Trello tracker e2e coverage

Scope: Trello: the offline fake lifecycle, worker board-actions polling, the read-only smoke, and the planned Layer 2 live board lifecycle.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Trello: offline fake key/`--query`, list move, comment, decoy isolation, worker board-actions polling

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-trello-fake.test.ts`, `tests/local/worker-trello-polling.test.ts`, `test:trackers` read-only smoke
- Missing: Live board lifecycle, search indexing, and live action-feed semantics.
- Last reviewed: 2026-11-17

### Offline fake Trello server (incl. `GET /boards/{id}/actions`)

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-trello-fake.test.ts`, `tests/local/worker-trello-polling.test.ts`
- Missing: Live board lifecycle.
- Last reviewed: 2026-11-17

### Trello polling through the board actions feed (null-cursor drain, `since` cursor, re-run on a new action, own writes, missing board id)

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-trello-polling.test.ts` (`bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`)
- Missing: The post-PR actioned gate on Trello (the bare remote creates no PR); live board and real action-feed pagination.
- Last reviewed: 2026-11-17

## Tracker plan status

### Trello

- Default `test`: yes (offline fake)
- Opt-in suite: `test:trackers` (read-only smoke)
- Notes: Fake lifecycle: key/`--query`, list move, comment. Worker board-actions polling (`since` cursor, re-run on new action) is offline. Real board lifecycle remains Layer 2.
- Last reviewed: 2026-11-17

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 2: ~~Offline fake Trello server with the card/list/comment lifecycle~~ (implemented by `tests/local/tracker-trello-fake.test.ts`).
- Priority 4: Trello lifecycle against a dedicated board (Layer 2), when that board and token exist.

## Layer 2 plan (live dedicated board)

### Layer 2 fixture variables

Required variables (exact names open for review); see the shared rules in
[trackers.md](trackers.md#fixture-configuration).

| Variable                      | Meaning                                            |
| ----------------------------- | -------------------------------------------------- |
| `E2E_TRELLO_BOARD_ID`         | Dedicated board that hosts test cards.             |
| `E2E_TRELLO_TODO_LIST`        | Initial list (default `To Do`).                    |
| `E2E_TRELLO_IN_PROGRESS_LIST` | In-progress list (default `Doing`).                |
| `E2E_TRELLO_REVIEW_LIST`      | List applied after PR creation (default `Review`). |

### Trello specifics

- Use a dedicated board, or at minimum dedicated lists, so list moves and labels
  do not touch the worker board.
- Lists are statuses: create the card in the todo list, move it to the review
  list after PR creation, and assert the card's list.
- Comments are card actions; delete only the scenario's comment actions.
- Cleanup deletes or archives only scenario-owned cards. Board-scoped labels are
  created idempotently and are either left in place or deleted only when the
  fixture created them.

## Layer 3 fake (implemented)

`providers/fake-trello.ts` serves the Trello REST subset the product calls on
`127.0.0.1:0` and owns the board, lists, labels, cards, comment actions,
checklists, and attachments in memory. `tests/local/tracker-trello-fake.test.ts`
seeds an expected card plus a decoy outside the selector, writes per-board list
statuses into `.devintern-code/settings.json`, and runs the production Trello
client through the built CLI for both explicit short-link and `--query`
selection. The list name is the status, so a run moves the card from the todo
list to the configured actioned list. It reads state back through the fixture
rather than CLI stdout.

Endpoints covered:

- `GET /members/me/boards`
- `GET /boards/{id}/lists`
- `GET /boards/{id}/labels`
- `GET` / `POST /cards`
- `GET` / `PUT /cards/{id}` (card detail, list moves, label replacement)
- `GET /cards/{id}/actions?filter=commentCard`
- `POST /cards/{id}/actions/comments`
- `GET /cards/{id}/checklists`, `POST /checklists`, `POST /checklists/{id}/checkItems`
- `GET` / `POST /cards/{id}/attachments`
- `GET /search` (optional `idBoards` scope, `is:open`, `list:"<name>"`, free text)
- `GET /boards/{id}/actions` (newest first; `since` as an action id or ISO
  date returns only newer actions; comma-separated `filter`; `limit` default 50,
  max 1000). Every card create/update/move/archive/comment/checklist/attachment
  appends one board action with a monotonic 24-hex id.

Any other route returns a diagnostic 404 naming the method and path, and the
test asserts no unexpected request occurred. The fake accepts any query
`key`/`token` credentials, never logs them, and makes no outbound requests.
Scenarios assert the pushed `feature/<short-link>` branch and exact
`src/greeting.ts` diff, the run record, the configured final list, the surviving
unrelated label, the implementation comment, the seeded comment, and
`--skip-comments` on a second run. The local bare Git remote is the code host; no
PR, GitHub token, Trello credentials, or model credentials are required. The
only skip is the existing built-CLI guard.

`tests/local/worker-trello-polling.test.ts` drives the same fake from a real
worker: the board-actions change detector's null-cursor backlog drain, the
`since=<newest action id>` idle ticks with no `/search`, the worker's own list
move and comment not looping, a human edit re-running the card exactly once,
and the startup refusal without `TRELLO_DEFAULT_BOARD_ID`.

What remains live: creating, moving, commenting on, and archiving cards on a real
dedicated board (Layer 2), including Trello's eventual search indexing. Trello
has no estimation concept, so there is no estimation coverage to add.

## Test notes

### Worker Trello polling (board actions feed)

`tests/local/worker-trello-polling.test.ts` starts the real `devintern worker`
with `[defaults].tracker = "trello"`, a one-second `poll_interval`, and a
`task_query` of `list:"To Do" is:open <marker>` against the in-process Trello
fake (`providers/fake-trello.ts`). Trello polling detects changes through
`GET /1/boards/{id}/actions`, not card search, so the fake appends a board
action for every card create, update, list move, archive, comment, checklist,
and attachment, honors `since` (action id or date), `filter`, and `limit`, and
records the parameters of every request in `boardActionRequests`.

The suite proves that the first tick (null cursor) drains the backlog once and
leaves a decoy on the same board untouched; that later ticks send
`since=<newest action id>` and, with an empty feed, never call `/search` or
re-run the card; that the worker's own list move and implementation comment
are detected but do not loop (the in-progress move takes the card out of the
query); and that a human edit (new description, moved back to To Do) triggers
exactly one more run. A second test drops `TRELLO_DEFAULT_BOARD_ID` and proves
the worker refuses to start ("Could not initialize the trello change
detector") without polling or running cards.

No Trello account, PR, or network access is needed; the local bare remote is
the code host. Build the CLI first; the tests skip only when
`packages/code/dist` is absent, and a skip is not a pass.

```bash
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
# or only this suite, from packages/e2e:
bun test tests/local/worker-trello-polling.test.ts
```
