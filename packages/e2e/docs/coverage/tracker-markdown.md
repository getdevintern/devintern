# Markdown tracker e2e coverage

Scope: local Markdown task files and mixed Markdown/tracker batches.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Markdown file tasks (single)

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/cli.test.ts`, `WorkerFixture`
- Missing: Markdown directory queries and status semantics are limited by design.
- Last reviewed: 2026-11-17

### Multiple Markdown files and mixed tracker-key batches

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/cli-batch.test.ts`
- Missing: Additional tracker combinations.
- Last reviewed: 2026-11-17

### Markdown worker: Depends on line holds a polled task until its blocker is done

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/worker-markdown-dependencies.test.ts` ("Markdown Depends-on line holds a polled task until its blocker is done or cancelled"; gap `MD-DEP-1`). `task-12` (`Depends on: api-schema`) and `task-13` (`Depends on: docs-update`) are `status: todo`, and both blockers are `in-progress`. `worker queue --json` lists each as a `markdown` tracker item with `dependencyState: "waiting"`, the blocker in `dependsOn`, and the reason `<blocker> not done (in-progress)`. Across two more gate re-checks there is no run record, no agent call, no pushed `feature/<key>` branch, and the file stays `todo`. Setting `api-schema` to `done` and then `docs-update` to `cancelled` (each followed by an edit of the dependent) releases each dependent exactly once: the run succeeds, the branch is pushed, the status leaves `todo`, the task leaves the queue, and it is not run again on later ticks. The blockers themselves are never run.
- Missing: Several blockers on one line (comma- or space-separated), where all of them must be done; `complete(d)` and `closed` statuses; a blocker the worker itself implemented (merged and stacked modes); team-scoped keys in a multi-team workspace; release without editing the dependent (the waiting backoff path).
- Last reviewed: 2026-11-22

### Markdown worker: unknown ticket-shaped blocker waits as not found; non-key words are ignored

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/worker-markdown-dependencies.test.ts` ("Markdown Depends-on unknown ticket-shaped keys wait as not found; prose words are ignored"; gap `MD-DEP-2`). `Depends on: PROJ-12, local-missing-thing` with no such task files holds the task with `dependsOn: ["PROJ-12", "local-missing-thing"]` (the tracker key keeps its case), a reason containing `PROJ-12` and `not found`, and the warning `names blockers markdown cannot find`. It stays held, with no run or branch, across two more gate re-checks. A task whose only lines are `Depends on: database (see task-99)` and `Depends on: misc words - after task-98` runs at once and exactly once: `database` and `misc words` are not key-shaped, and the key-shaped words after the parenthesis or dash are ignored. The product matches `docs/code/worker.md`.
- Missing: A bare word with a hyphen or digit and no task file that is not ticket-shaped (for example `third-party`, `v2`), which should be ignored; a key whose file name differs only in case; a `.md` suffix on the key.
- Last reviewed: 2026-11-22

## Tracker plan status

### Markdown

- Default `test`: no
- Opt-in suite: `test:trackers` (read-only path)
- Notes: Plain files, no credentials.
- Last reviewed: 2026-11-17

## Test notes

### Worker dependency gate

`tests/local/worker-markdown-dependencies.test.ts` starts the built worker with the default `markdown` tracker, `MARKDOWN_TASKS_DIR` pointed at a tasks folder inside the fixture root, `task_query = "status=todo"`, and `poll_interval = 1`. It uses the deterministic fake agent with a unique description marker. Markdown has no fake server to count ticks against, so the suite counts gate re-checks through the `updated_at` of the dependent's `tracker_dependencies` row in `queue.db`. It releases a dependent by editing the blocker's `status:` and then touching the dependent: the new modification time is a new update stamp, so the task is re-checked on the next tick instead of after the waiting backoff.

Run it with the default offline suite (`bun run --filter @devintern/e2e test`) after `bun run --filter @getdevintern/code build`. It has no prerequisites: no network, no credentials, and no tracker account.
