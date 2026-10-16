# Pipeline plugin examples

Runnable examples for customizing the task-delivery pipeline of
[`@getdevintern/code`](../../packages/code). Every example uses the public
`@getdevintern/code/pipeline` API, ships complete TypeScript, a pipeline
registration, fixtures, and an automated test that exercises its success and
failure paths.

Read [`docs/code/pipelines.md`](../../docs/code/pipelines.md) first for the
pipeline model: default flow, required ordering, built-in `verify`, custom
steps, and configuration precedence.

## Examples

| Example | What it shows | Kind |
| ------- | ------------- | ---- |
| [`run-tests/`](./run-tests) | Run a real Bun command after commit and halt on non-zero exit. | Deterministic |
| [`check-policy/`](./check-policy) | Block newly added files under forbidden paths. | Deterministic |
| [`verify-artifacts/`](./verify-artifacts) | Require a generated artifact to exist and match a schema; expose it via `context.results`. | Deterministic |
| [`transient-retry/`](./transient-retry) | `StepExecutionError` single-retry semantics, contrasted with a permanent halt. | Deterministic |
| [`agent-review/`](./agent-review) | Agent-backed review using `getDiff`/`runAgentPrompt`/`parseReviewFeedback`/`filterByPriority`, with a bounded repeat. | Agent |
| [`pr-explainer-narrative/`](./pr-explainer-narrative) | Diff-grounded reviewer narrative. | Agent |
| [`pr-explainer-visual/`](./pr-explainer-visual) | Visual Summary/Evidence/Merge-Danger explainer. | Agent |
| [`pr-explainer-image/`](./pr-explainer-image) | Generate a PNG explainer and embed it in the PR through a reusable Files SDK uploader. | Agent + image tool |

The two explainer variants share an execution scaffold in
[`shared/explainer.ts`](./shared/explainer.ts). Test scaffolding shared by every
example lives in [`shared/harness.ts`](./shared/harness.ts).

## Requirements

- `@getdevintern/code` 2.17.0 or later (the version that ships the public
  `@getdevintern/code/pipeline` API and the workspace pipeline support).
- [Bun](https://bun.sh) — the CLI runtime and what the examples use throughout.

Agent-backed examples need a configured harness (`AGENT_HARNESS`, default
`claude-code`) to run live. Their **automated tests do not** — the harness
injects a deterministic `runAgentPrompt`, so the suite never calls a model.

## Run the example suite

```bash
bun run examples/pipeline-plugins/run-tests.ts
```

The runner discovers `**/tests/*.test.ts`, isolates workspace/queue state in a
temp directory, and disables production error reporting. It never touches your
real repository or tracker.

## Install and copy a plugin

Each example README has exact commands. The usual shape is:

```bash
mkdir -p .devintern-code/steps
cp <example>/plugin.ts .devintern-code/steps/<name>.ts
bun add -d @getdevintern/code
# then merge the example's settings.json "pipeline" block
```

The plugin runs **inside the task process** with that process's environment and
permissions — the same access your coding agent has. Review any example before
running it unattended.

### Installing a plugin from a package

A plugin can also be published as an npm package that default-exports a
`StepDefinition`. Reference the package name from `pipeline.plugins`:

```json
{ "pipeline": { "plugins": ["@acme/devintern-steps"], "steps": ["…"] } }
```

Package names resolve with `Bun.resolveSync` from the directory of the
declaring configuration: the repository root for `.devintern-code/settings.json`,
or the pipeline file's directory for a workspace `pipeline_file`. Install the
package and its dependencies **next to that file** so resolution succeeds.
Community plugins are maintained in their own repositories; this repository
does not endorse or host a plugin marketplace.

## Contributing an example

Propose a new example in this directory when it demonstrates real pipeline
behavior that does not already have a runnable counterpart.

Required files per example:

- `plugin.ts` — self-contained, imports only from the public API.
- `settings.json` — a complete `pipeline` block with the step placed correctly.
- `README.md` — files, options, setup, expected output, and a success/failure
  walkthrough.
- `fixtures/` — small, isolated inputs. Never point at developer state, a real
  tracker, a real PR, or a network service.
- `tests/*.test.ts` — automated validation through
  `@getdevintern/code/pipeline`'s `runTaskSteps` (see `shared/harness.ts`).

Quality bar:

- **Validate options.** Fail fast on missing/typed options before doing work.
- **Bound execution.** Cap captured output and any iteration count.
- **Write useful failures.** A `halt` reason should say what failed, where, and
  what to do next.
- **Validate the advertised behavior.** Test the substantive success *and*
  failure paths, not just that the plugin loads.
- **Keep mutations honest.** If a step writes repo files after `commit`, add an
  explicit recommit path (a `repeat` to `commit`) before `finalize`.

Run before opening a pull request:

```bash
bun run examples/pipeline-plugins/run-tests.ts
bunx oxfmt --check "examples/pipeline-plugins/**/*.ts"
bunx oxlint examples/pipeline-plugins
bunx tsc --noEmit -p examples/pipeline-plugins
```

## Reuse and attribution

Prompt guidance in the explainer examples is adapted from public skill
repositories. Pinned revisions, licences, and what was adapted are recorded in
each variant's `CREDITS.md`. The visual guidance originates in Humanlayer's
`show-me` skill by Dex Horthy.

## Follow-ups

- **Official plugin repository.** Revisit a maintained, installable plugin
  repository after the public API stabilizes and there is demand for it.

## Where the explainer output goes

Explainers register immutable outputs through `context.artifacts.addFile`.
The narrative key is `explanation-narrative`; the visual key is
`explanation-visual`. Their `settings.json` files explicitly select publication
in one managed PR comment. The same artifacts appear in the dashboard, scoped
to the exact run.
See [Pipeline artifacts](../../docs/code/artifacts.md) for the full contract.

The image example registers `explanation-image` and selects it for `embed`
publication. Its copyable storage module uses the public
`createFilesArtifactUploader` factory with a configured Files SDK backend and
a durable public URL. It needs an image-capable harness; the Markdown
explainer variants work with text-only harnesses.
