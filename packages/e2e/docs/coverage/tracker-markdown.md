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

## Tracker plan status

### Markdown

- Default `test`: no
- Opt-in suite: `test:trackers` (read-only path)
- Notes: Plain files, no credentials.
- Last reviewed: 2026-11-17
