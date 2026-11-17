# Trello tracker e2e coverage

Scope: Trello: the offline fake lifecycle, the read-only smoke, and the planned Layer 2 live board lifecycle.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Trello: offline fake key/`--query`, list move, comment, decoy isolation

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-trello-fake.test.ts`, `test:trackers` read-only smoke
- Missing: Live board lifecycle and search indexing.
- Last reviewed: 2026-11-17

### Offline fake Trello server

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-trello-fake.test.ts`
- Missing: Live board lifecycle.
- Last reviewed: 2026-11-17

## Tracker plan status

### Trello

- Default `test`: no
- Opt-in suite: `test:trackers` (read-only smoke)
- Notes: Full lifecycle planned in Layer 2.
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

Any other route returns a diagnostic 404 naming the method and path, and the
test asserts no unexpected request occurred. The fake accepts any query
`key`/`token` credentials, never logs them, and makes no outbound requests.
Scenarios assert the pushed `feature/<short-link>` branch and exact
`src/greeting.ts` diff, the run record, the configured final list, the surviving
unrelated label, the implementation comment, the seeded comment, and
`--skip-comments` on a second run. The local bare Git remote is the code host; no
PR, GitHub token, Trello credentials, or model credentials are required. The
only skip is the existing built-CLI guard.

What remains live: creating, moving, commenting on, and archiving cards on a real
dedicated board (Layer 2), including Trello's eventual search indexing. Trello
has no estimation concept, so there is no estimation coverage to add.
