# pr-explainer-narrative

Generate a concise, reviewer-facing Markdown explanation of the final change:
why it is needed, what changed grouped by purpose, validation actually
evidenced, risks, and where reviewers should focus. It runs **after `commit`
and any verification/auto-review/repair steps, immediately before `finalize`**,
so it describes the final diff.

- API: `@getdevintern/code/pipeline` (plus `untrustedContentBlock`)
- DevIntern: `@getdevintern/code` 2.17.0 or later
- Mutates files: no repository files; writes an artifact under `context.outputDir`
- Placement: after verification/auto-review, immediately before `finalize`

## Files

| File                                  | Purpose                                            |
| ------------------------------------- | -------------------------------------------------- |
| `plugin.ts`                           | Registers the shared explainer scaffold.           |
| `prompts/narrative.md`                | Editable narrative prompt.                         |
| `settings.json`                       | Pipeline registration.                             |
| `fixtures/sample.diff`                | Fixture diff (shared with the visual variant).     |
| `fixtures/expected.md`                | Example output.                                    |
| `CREDITS.md`                          | Provenance and pinned revisions.                   |
| `tests/pr-explainer-narrative.test.ts`| Artifact, evidence grounding, and advisory paths.  |

The execution scaffold is shared with the visual variant in
`../shared/explainer.ts`.

## Setup

```bash
mkdir -p .devintern-code/steps .devintern-code/prompts
cp examples/pipeline-plugins/shared/explainer.ts .devintern-code/steps/explainer.ts
cp examples/pipeline-plugins/pr-explainer-narrative/plugin.ts .devintern-code/steps/pr-explainer-narrative.ts
cp examples/pipeline-plugins/pr-explainer-narrative/prompts/narrative.md .devintern-code/prompts/pr-explainer-narrative.md
bun add -d @getdevintern/code
```

Adjust the import in the copied `plugin.ts` to point at
`./explainer.ts`, then merge the `pipeline` block from `settings.json`.

## Result

The step writes `pr-explanation.md` under `context.outputDir` and returns
structured data:

```ts
{ kind: "continue", data: { path: "<outputDir>/pr-explanation.md", content: "..." } }
```

**PR body integration.** The CLI's PR-body builder picks up the `content` a
`pr-explainer-*` step records in `context.results` and appends it as an
`Explanation` section on the PR. The artifact is also listed under the run's
**Artifacts** card in the local dashboard (`devintern dashboard`). Both paths
are advisory: if generation fails, the step returns `{ kind: "warn" }` and
publication continues.

## Validate

```bash
bun run examples/pipeline-plugins/run-tests.ts pr-explainer-narrative
```
