# run-tests

Run a real command (Bun tests or a typecheck) after the implementation is
committed, and **halt publication when it exits non-zero**. This is a
deterministic check — no agent is involved — so it is cheap and reproducible.

- API: `@getdevintern/code/pipeline`
- DevIntern: `@getdevintern/code` 2.17.0 or later
- Mutates files: no (the test command may, but the plugin does not)
- Placement: after `commit`, before `finalize`

## Files

| File                                          | Purpose                                            |
| --------------------------------------------- | -------------------------------------------------- |
| `plugin.ts`                                       | The step definition.                               |
| `settings.json`                                   | Pipeline registration for `.devintern-code/settings.json`. |
| `fixtures/sample/pass.fixture.ts`, `fail.fixture.ts` | A tiny reproducible success/failure fixture.    |
| `tests/run-tests.test.ts`                         | Automated validation of all three paths.           |

The fixture files use the `.fixture.ts` suffix so a top-level `bun test` never
discovers the deliberate failure. The plugin runs them explicitly via
`bun test ./pass.fixture.ts` with `cwd` set.

## Setup

1. Copy the plugin into your repository:

   ```bash
   mkdir -p .devintern-code/steps
   cp examples/pipeline-plugins/run-tests/plugin.ts .devintern-code/steps/run-tests.ts
   bun add -d @getdevintern/code   # only if it is not already installed
   ```

2. Merge the `pipeline` block from `settings.json` into
   `.devintern-code/settings.json`.

3. Run a task as usual. The pipeline prints the command result and halts before
   `finalize` if the command fails.

## Options

| Option                | Default     | Meaning                                             |
| --------------------- | ----------- | --------------------------------------------------- |
| `command`             | `"bun"`     | Executable to run.                                  |
| `args`                | `["test"]`  | Argument array. Never a shell string.               |
| `cwd`                 | `"."`       | Working directory relative to `context.workingDir`. |
| `maxDiagnosticsBytes` | `4000`      | Cap on captured stdout+stderr.                      |
| `onFail`              | `"halt"`    | `warn` records the failure but continues.           |

## Walkthrough

Success — run the passing fixture directly:

```bash
cd examples/pipeline-plugins/run-tests/fixtures/sample
bun test ./pass.fixture.ts
```

With the plugin registered, a configured `args: ["test", "./pass.fixture.ts"]`
exits `0` and the pipeline continues to `finalize`.

Failure — the same command against the deliberate failure:

```bash
cd examples/pipeline-plugins/run-tests/fixtures/sample
bun test ./fail.fixture.ts
```

The plugin captures the failing output and returns
`{ kind: "halt", reason: "Verification command ... failed with exit code 1..." }`.
Publication stops before a PR is opened. To make the check advisory instead,
set `"onFail": "warn"`.

Validate the example itself:

```bash
bun run examples/pipeline-plugins/run-tests.ts run-tests
```
