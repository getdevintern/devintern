# pr-explainer-visual

Generate a visual-first, evidence-heavy explanation of the final change with
**Summary**, **Evidence**, and **Merge Danger** sections. It runs after
`commit` and any verification/auto-review/repair steps, immediately before
`finalize`, so it reflects the final diff.

- API: `@getdevintern/code/pipeline` (plus `untrustedContentBlock`)
- DevIntern: `@getdevintern/code` 2.17.0 or later
- Mutates files: no repository files; writes an artifact under `context.outputDir`
- Placement: after verification/auto-review, immediately before `finalize`

## Files

| File                               | Purpose                                            |
| ---------------------------------- | -------------------------------------------------- |
| `plugin.ts`                        | Registers the shared explainer scaffold.           |
| `prompts/visual.md`                | Editable visual prompt.                            |
| `pipeline.json`                    | Workspace pipeline file.                           |
| `fixtures/sample.diff`             | Fixture diff (shared with the narrative variant).  |
| `fixtures/expected.md`             | Example output.                                    |
| `CREDITS.md`                       | Provenance and pinned revisions.                   |
| `tests/pr-explainer-visual.test.ts`| Artifact, sections, and advisory-failure paths.    |

The execution scaffold is shared with the narrative variant in
`../shared/explainer.ts`.

## Setup

```bash
mkdir -p ~/.devintern/pipelines/steps ~/.devintern/pipelines/prompts
cp examples/pipeline-plugins/shared/explainer.ts ~/.devintern/pipelines/steps/explainer.ts
cp examples/pipeline-plugins/pr-explainer-visual/plugin.ts ~/.devintern/pipelines/steps/pr-explainer-visual.ts
cp examples/pipeline-plugins/pr-explainer-visual/prompts/visual.md ~/.devintern/pipelines/prompts/pr-explainer-visual.md
cp examples/pipeline-plugins/pr-explainer-visual/pipeline.json ~/.devintern/pipelines/backend.json
cd ~/.devintern/pipelines && bun add @getdevintern/code
```

Adjust the import in the copied `plugin.ts` to point at `./explainer.ts`.

Set `pipeline_file = "pipelines/backend.json"` on the repository's
`[[repos]]` entry in `~/.devintern/workspace.toml` (see
[Install and copy a plugin](../README.md#install-and-copy-a-plugin)).

`promptFile` is read relative to the task checkout, so the pipeline file
gives it as an absolute path: replace `/home/you` with your home directory.

## Choosing a style

- **Narrative** reads well in a PR description or a review hand-off: prose,
  grouped by purpose, with motivation up front.
- **Visual** reads well for reviewers in a hurry: a small diagram or diff sketch,
  explicit evidence, and a concrete reversibility/blast-radius statement.

Both share the same output path and structured result shape, so you can switch
by swapping the `use` entry and prompt. Keep the timing (final diff, evidence
grounding, untrusted framing, advisory failure) identical.

## Result

The step writes `pr-explanation.md` and registers an immutable artifact with key
`explanation-visual` through `context.artifacts.addFile`. The returned
`data` contains the source `path`; report bodies live in the artifact registry.

The example settings explicitly select this key for one managed GitHub PR
comment. The dashboard displays the same registered output for this run.
Generation, capture, and publication failures remain advisory.
See [Pipeline artifacts](../../../docs/code/artifacts.md) for the full contract,
upload adapters, and plugin configuration.

## Validate

```bash
bun run examples/pipeline-plugins/run-tests.ts pr-explainer-visual
```
