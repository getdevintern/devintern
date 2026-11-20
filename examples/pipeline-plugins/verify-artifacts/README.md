# verify-artifacts

Check that a **generated artifact exists and matches the fields a downstream
consumer requires** after implementation/build. The parsed artifact is returned
as structured `data`, so a later step can read it through `context.results`
without re-reading the file.

- API: `@getdevintern/code/pipeline`
- DevIntern: `@getdevintern/code` 2.17.0 or later
- Mutates files: no (reads only)
- Placement: after `commit`, before `finalize`

## Files

| File                                    | Purpose                                            |
| --------------------------------------- | -------------------------------------------------- |
| `plugin.ts`                             | The step definition.                               |
| `pipeline.json`                         | Workspace pipeline file. |
| `fixtures/generate.ts`                  | Tiny generator that writes a valid or invalid report. |
| `tests/verify-artifacts.test.ts`        | Valid, missing, invalid-field, and malformed paths.|

## Setup

1. Copy the plugin and its pipeline file into your workspace:

   ```bash
   mkdir -p ~/.devintern/pipelines/steps
   cp examples/pipeline-plugins/verify-artifacts/plugin.ts ~/.devintern/pipelines/steps/verify-artifacts.ts
   cp examples/pipeline-plugins/verify-artifacts/pipeline.json ~/.devintern/pipelines/backend.json
   cd ~/.devintern/pipelines && bun add @getdevintern/code
   ```

2. Set `pipeline_file = "pipelines/backend.json"` on the repository's
   `[[repos]]` entry in `~/.devintern/workspace.toml` (see
   [Install and copy a plugin](../README.md#install-and-copy-a-plugin)).

3. Produce the artifact before this step runs (in your build, or a preceding
   `run-tests` step):

   ```bash
   bun run examples/pipeline-plugins/verify-artifacts/fixtures/generate.ts valid ./dist
   ```

## Options

| Option           | Default    | Meaning                                                     |
| ---------------- | ---------- | ----------------------------------------------------------- |
| `path`           | (required) | Artifact path relative to `context.workingDir`.             |
| `requiredFields` | `[]`       | Fields that must be present and non-empty.                  |
| `onFail`         | `"halt"`   | `warn` records the finding but continues.                   |

## Walkthrough

Valid — generate a compliant artifact and the step continues, exposing
`data: { path, artifact }`. The source file is also registered as
`verified-artifact` before parsing, so failed validation retains the evidence
in the dashboard. Publishing it requires an explicit artifact selection.

Invalid — generate without `checks`, or point `path` at a missing file:

```bash
bun run examples/pipeline-plugins/verify-artifacts/fixtures/generate.ts invalid ./dist
```

The step returns `{ kind: "halt" }` with a reason naming the file and the
missing field. A later step can inspect the structured result:

```ts
const record = context.results.find((entry) => entry.step === "verify-artifacts");
const data = record?.result.data as { path: string; artifact: unknown } | undefined;
```

Validate the example itself:

```bash
bun run examples/pipeline-plugins/run-tests.ts verify-artifacts
```
