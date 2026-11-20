# agent-review

An agent-backed review step built entirely from the public `PipelineContext`
helpers: `getDiff()`, `runAgentPrompt()`, `parseReviewFeedback()`, and
`filterByPriority()`. On blocking findings it returns a **bounded repeat from
`implement`** with structured feedback, so the implementation is revised and
recommitted before the diff is checked again.

- API: `@getdevintern/code/pipeline` (plus `untrustedContentBlock`)
- DevIntern: `@getdevintern/code` 2.17.0 or later
- Mutates files: no (the repeated `implement`/`commit` steps do)
- Placement: after `commit`, after deterministic checks, before `finalize`

## Files

| File                                   | Purpose                                               |
| -------------------------------------- | ----------------------------------------------------- |
| `plugin.ts`                            | The step definition.                                  |
| `prompts/review.md`                    | Editable review instructions.                         |
| `pipeline.json`                        | Workspace pipeline file.                              |
| `fixtures/sample.diff`                 | The diff under review.                                |
| `fixtures/blocking-verdict.json`       | A verdict with a high-severity finding.               |
| `fixtures/approved-verdict.json`       | A clean, approving verdict.                           |
| `tests/agent-review.test.ts`           | Loopback, bounded-repeat, halt, malformed, and framing paths. |

## Setup

1. Copy the plugin, prompt, and pipeline file into your workspace:

   ```bash
   mkdir -p ~/.devintern/pipelines/steps ~/.devintern/pipelines/prompts
   cp examples/pipeline-plugins/agent-review/plugin.ts ~/.devintern/pipelines/steps/agent-review.ts
   cp examples/pipeline-plugins/agent-review/prompts/review.md ~/.devintern/pipelines/prompts/agent-review.md
   cp examples/pipeline-plugins/agent-review/pipeline.json ~/.devintern/pipelines/backend.json
   cd ~/.devintern/pipelines && bun add @getdevintern/code
   ```

2. Set `pipeline_file = "pipelines/backend.json"` on the repository's
   `[[repos]]` entry in `~/.devintern/workspace.toml` (see
   [Install and copy a plugin](../README.md#install-and-copy-a-plugin)).

`promptFile` is read relative to the task checkout, so the pipeline file
gives it as an absolute path: replace `/home/you` with your home directory.

## Options

| Option          | Default      | Meaning                                                    |
| --------------- | ------------ | ---------------------------------------------------------- |
| `prompt`        | —            | Inline review instructions.                                |
| `promptFile`    | —            | Path to a prompt file relative to `context.workingDir`.    |
| `minPriority`   | `"medium"`   | Lowest priority that blocks.                               |
| `maxIterations` | `2`          | Bounded repair cycles (`maxRepeats` on the repeat).        |
| `onBlocked`     | `"loopback"` | `halt` stops (`haltKind: "stop"`); `warn` continues.       |

## Behavior

- The diff is framed with the public `untrustedContentBlock` helper before it
  reaches the agent, and the task/diff are labelled as untrusted data.
- A malformed verdict is retried once; a second malformed verdict halts.
- `onBlocked: "loopback"` returns
  `{ kind: "repeat", from: "implement", maxRepeats, feedback }`. The runner
  re-executes `implement`, then `commit`, then this step. When the bounded repeat
  count is exceeded the runner halts with
  `"... exceeded its repeat limit (N)"`.
- `haltKind: "stop"` halts delivery without changing the task's status; a plain
  `halt` marks the task incomplete and returns it to To Do.

## Walkthrough

With a blocking verdict followed by an approving one, the pipeline loops once
(`implement` runs twice) and finishes. With a permanently blocking verdict it
halts after the repeat bound. Both are covered by
`tests/agent-review.test.ts`.

Validate the example itself:

```bash
bun run examples/pipeline-plugins/run-tests.ts agent-review
```
