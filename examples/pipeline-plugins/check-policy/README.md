# check-policy

Block a change that **adds files under explicitly forbidden paths**. Unlike a
threshold placeholder, this enforces a concrete repository policy: it reads the
diff against the PR target (`context.getDiff()`) and inspects the newly added
files it contains.

- API: `@getdevintern/code/pipeline`
- DevIntern: `@getdevintern/code` 2.17.0 or later
- Mutates files: no
- Placement: after `commit`, before `finalize`

## Files

| File                            | Purpose                                             |
| ------------------------------- | --------------------------------------------------- |
| `plugin.ts`                     | The step definition and diff parser.                |
| `settings.json`                 | Pipeline registration.                              |
| `fixtures/sample.diff`          | A fixture diff that adds `secrets/prod.key`.        |
| `tests/check-policy.test.ts`    | Automated validation of the parser and both results.|

## Setup

1. Copy the plugin into your repository:

   ```bash
   mkdir -p .devintern-code/steps
   cp examples/pipeline-plugins/check-policy/plugin.ts .devintern-code/steps/check-policy.ts
   bun add -d @getdevintern/code
   ```

2. Merge the `pipeline` block from `settings.json` into
   `.devintern-code/settings.json` and adjust `forbiddenPaths`.

## Options

| Option            | Default                          | Meaning                              |
| ----------------- | -------------------------------- | ------------------------------------ |
| `forbiddenPaths`  | `["secrets/", "credentials/"]`   | Path prefixes new files must avoid.  |
| `onFail`          | `"halt"`                         | `warn` records findings but continues.|

Matching is prefix-aware: a rule of `"secrets/"` matches `secrets/a.key` and
`src/secrets/a.key`, but not `src/not-secrets/a.ts`.

## Walkthrough

Advisory — the same diff with a non-matching rule continues to `finalize`.
Blocking — with `forbiddenPaths: ["secrets/"]`, the plugin returns
`{ kind: "halt" }` and the reason names the offending file:

```
Policy violation: 1 newly added file(s) fall under a forbidden path.
  - secrets/prod.key (matches "secrets/")
Move the file out of the forbidden path or get an explicit exception before publishing.
```

Set `"onFail": "warn"` to surface the finding without stopping publication.

Validate the example itself:

```bash
bun run examples/pipeline-plugins/run-tests.ts check-policy
```
