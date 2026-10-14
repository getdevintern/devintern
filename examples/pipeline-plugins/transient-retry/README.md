# transient-retry

Demonstrate `StepExecutionError` retry semantics. A step that throws
`StepExecutionError` is retried **exactly once**; a second throw halts the
pipeline. Use it for a transient infrastructure failure — a flaky remote, a
momentarily unavailable dependency.

This is deliberately **not** for a failing test or a policy verdict. Those are
permanent findings and must return `{ kind: "halt" }` (see the `run-tests` and
`check-policy` examples). Returning `halt` does not retry; only a thrown
`StepExecutionError` does.

- API: `@getdevintern/code/pipeline`
- DevIntern: `@getdevintern/code` 2.17.0 or later
- Mutates files: writes a counter file (`statePath`) to simulate failures
- Placement: anywhere after `implement`

## Files

| File                              | Purpose                                          |
| --------------------------------- | ------------------------------------------------ |
| `plugin.ts`                       | The step definition.                             |
| `settings.json`                   | Pipeline registration.                           |
| `tests/transient-retry.test.ts`   | Transient-success, transient-exhausted, and permanent-finding paths. |

## Setup

1. Copy the plugin into your repository:

   ```bash
   mkdir -p .devintern-code/steps
   cp examples/pipeline-plugins/transient-retry/plugin.ts .devintern-code/steps/transient-retry.ts
   bun add -d @getdevintern/code
   ```

2. Merge the `pipeline` block from `settings.json`.

## Options

| Option             | Default                                             | Meaning                                   |
| ------------------ | --------------------------------------------------- | ----------------------------------------- |
| `statePath`        | `.devintern-code/transient-retry-state.json`        | Counter file relative to `workingDir`.    |
| `failures`         | `0`                                                 | Simulated transient failures before success. |
| `permanentFailure` | `false`                                             | Return `halt` immediately, to show the contrast. |

## Walkthrough

- `failures: 1` — the first call throws `StepExecutionError`; the runner retries
  it; the retry succeeds and the pipeline continues.
- `failures: 2` — the first call throws, the retry throws again, and the runner
  halts with the error message. This is the single-retry bound.
- `permanentFailure: true` — returns `{ kind: "halt" }` with no retry, the
  correct shape for a failed check.

Validate the example itself:

```bash
bun run examples/pipeline-plugins/run-tests.ts transient-retry
```
