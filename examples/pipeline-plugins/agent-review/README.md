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
   cp examples/pipeline-plugins/shared/prompt-path.ts ~/.devintern/pipelines/steps/prompt-path.ts
   cp examples/pipeline-plugins/agent-review/prompts/review.md ~/.devintern/pipelines/prompts/agent-review.md
   cp examples/pipeline-plugins/agent-review/pipeline.json ~/.devintern/pipelines/backend.json
   cd ~/.devintern/pipelines && bun add @getdevintern/code
   ```

   In the copied `agent-review.ts`, change the `../shared/prompt-path` import to
   `./prompt-path.ts`.

2. Set `pipeline_file = "pipelines/backend.json"` on the repository's
   `[[repos]]` entry in `~/.devintern/workspace.toml` (see
   [Install and copy a plugin](../README.md#install-and-copy-a-plugin)).

A relative `promptFile` such as `./prompts/agent-review.md` is read next to the
pipeline file (`~/.devintern/pipelines/`), so the same pipeline works for
every repository. An absolute path is used as written. Requires
`@getdevintern/code` 2.30.0 or later; older versions read a relative path
from the task checkout.

**Upgrading from an earlier copy of this plugin:** two things change when you
copy in the new `plugin.ts`.

- A relative `promptFile` now resolves next to the pipeline file, not the task
  checkout. If yours points into the repository (for example
  `./.devintern-code/prompts/review.md`), move the prompt next to the pipeline
  file or switch to an absolute path.
- A `promptFile` that does not exist now halts the step, naming the path it
  tried. Earlier copies fell back to the built-in instructions without telling
  you.

The explainer plugins warn and skip when their prompt is missing, but
agent-review halts. Agent review is a gate that decides whether work ships, so
running it with instructions other than the ones you configured is unsafe. An
explanation is optional output, so skipping it is harmless.

## Options

| Option          | Default      | Meaning                                                    |
| --------------- | ------------ | ---------------------------------------------------------- |
| `prompt`        | —            | Inline review instructions.                                |
| `promptFile`    | —            | Prompt file; relative paths resolve next to the pipeline file. A missing file halts the step. |
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
