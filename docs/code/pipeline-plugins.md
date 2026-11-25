---
title: "Writing Pipeline Plugin Steps"
sidebarLabel: "Pipeline plugins"
description: "Use when writing custom TypeScript steps for the task pipeline: the step API, step results, artifacts, retries, and how plugins are loaded."
section: "Automation Reference"
order: 2.5
dateModified: 2026-11-18
---

# Writing Pipeline Plugin Steps

A plugin step is a TypeScript module you add to the [task pipeline](./pipelines.md). Use one for checks a command can answer (tests, policy rules, schema validation) or for your own agent-backed steps. For built-in steps, ordering rules, and `verify`, see [Customizing the Task Pipeline](./pipelines.md).

Plugins run inside the task process with its environment, credentials, and permissions: the same access your coding agent has. Only load code you trust.

## Minimal plugin

The module default-exports a `StepDefinition`:

```ts
import type { PipelineContext, StepDefinition, TaskStepResult } from "@getdevintern/code/pipeline";

const definition: StepDefinition = {
  name: "check-policy",
  create(config) {
    // Called once when the pipeline is resolved, with the step's options.
    return {
      name: "check-policy",
      async run(context: PipelineContext): Promise<TaskStepResult> {
        if (config.dryRun === true) return { kind: "continue", data: { dryRun: true } };
        return { kind: "continue" };
      },
    };
  },
};

export default definition;
```

Register it in the pipeline file's `plugins` and place it in `steps`:

```json
{
  "plugins": ["./steps/check-policy.ts"],
  "steps": [
    { "use": "implement" },
    { "use": "commit" },
    { "use": "check-policy", "dryRun": false },
    { "use": "finalize" }
  ]
}
```

Rules:

- Step names must be unique and non-empty, must not start with `__`, and cannot reuse a reserved name: `clarity`, `implement`, `commit`, `verify`, `auto-review`, `finalize`, `publish`, `repair`.
- A plugin step may appear only once in a pipeline.
- `create(config)` receives the step entry's options without `use`. Validating them is up to the plugin.
- Plugin steps run after `implement` and before `finalize`. If a step changes files after `commit`, return `{ kind: "repeat", from: "commit", maxRepeats: 1 }` so they get committed, or place the step before `commit`.

## `PipelineContext`

The same `context` object is passed to every step.

| Field                                                  | Meaning                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `taskKey`, `taskSummary`, `task`, `tracker`            | Task identity and tracker client (may be undefined for Markdown tasks).    |
| `projectSettings`                                      | Tracker settings from `[trackers]` in `workspace.toml`, or `null`.         |
| `taskContent`, `taskFile`                              | The formatted task prompt and the path to its file.                        |
| `workingDir`                                           | The repository worktree the task runs in.                                  |
| `pipelineDir`                                          | Absolute directory of the `pipeline_file` that declared the pipeline, or `null` for the built-in default. |
| `outputDir`                                            | The task output directory.                                                 |
| `artifacts`                                            | Register and read [artifacts](#artifacts-from-steps).                      |
| `output`                                               | The implementation output (agent stdout).                                  |
| `committed`                                            | Whether the implementation has been committed.                             |
| `prTargetBranch`                                       | Base branch for the PR and diff.                                           |
| `enableGit`, `createPr`, `skipComments`, `autoReview`  | Effective run flags.                                                       |
| `autoReviewIterations`, `maxTurns`                     | Limits.                                                                    |
| `warnings`                                             | Warning strings collected so far.                                          |
| `results`                                              | Every step record so far as `{ step, result }`, including `data`.          |
| `loopbackFeedback`, `loopbackReason`                   | Set by a `repeat` for the re-run.                                          |
| `runAgentPrompt(prompt)`                               | Run the configured agent and return its stdout.                            |
| `getDiff()`                                            | Unified diff against `prTargetBranch`.                                     |
| `parseReviewFeedback(output, options?)`                | Parse a JSON review verdict. `options.minPriority` defaults to `medium`.   |
| `filterByPriority(items, min)`                         | Keep findings at or above a priority.                                      |

Steps pass data to each other through `data` on their result: a later step reads it from `context.results`.

DevIntern resolves relative `plugins` entries next to the pipeline file but passes step options to `create(config)` as written. To keep a prompt or other config file next to the pipeline, resolve it against `pipelineDir` and fall back to `workingDir` when it is `null`:

```ts
import { isAbsolute, resolve } from "node:path";

const file = isAbsolute(promptFile)
  ? promptFile
  : resolve(context.pipelineDir ?? context.workingDir, promptFile);
```

The example plugins `agent-review` and `pr-explainer-*` do this for `promptFile`, so `"promptFile": "./prompts/review.md"` reads `~/.devintern/pipelines/prompts/review.md` for a pipeline in `~/.devintern/pipelines/`. Before `@getdevintern/code` 2.30.0 they resolved a relative `promptFile` against the task checkout; if your pipeline file still points at a checkout file such as `./.devintern-code/prompts/review.md`, use an absolute path or move the prompt next to the pipeline file.

## Step results

`run` returns one of these. Returning nothing means `continue`.

| Result   | Shape                                                    | Effect                                                                                                       |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| continue | `{ kind: "continue", data? }`                            | Go to the next step.                                                                                         |
| warn     | `{ kind: "warn", reason, data? }`                        | Add a warning and continue.                                                                                  |
| halt     | `{ kind: "halt", reason, haltKind?, data? }`             | Stop and mark the task incomplete. With `haltKind: "stop"`, stop delivery without changing the task status or posting tracker feedback. |
| repeat   | `{ kind: "repeat", from, maxRepeats, reason?, feedback? }` | Re-run from an earlier step `from` through this step, at most `maxRepeats` times; then the pipeline halts. |

`feedback` (a `ReviewFeedback`) is available to the re-run as `context.loopbackFeedback`; the built-in `implement` step turns it into a repair prompt. Repeating from `implement` re-runs `implement`, `commit`, and every step up to the repeating one.

## Artifacts from steps

Register files you want visible in the dashboard, and optionally on the PR:

```ts
await context.artifacts.addFile({
  key: "explanation-narrative",
  path: reportPath,
  title: "Change explanation",
  kind: "explanation",
  mediaType: "text/markdown",
});
```

Each call saves a snapshot, so later edits or retries do not overwrite earlier evidence. Use `context.artifacts.list()`, `readText(id)`, and `readBytes(id)` to read registered artifacts, such as the built-in `verification` report. Key format, kinds, limits, and PR publication are covered in [Pipeline artifacts](./artifacts.md).

## Transient retries with `StepExecutionError`

Throw `StepExecutionError` for a temporary failure worth one retry, such as a flaky remote:

```ts
import { StepExecutionError } from "@getdevintern/code/pipeline";

async run(context) {
  try {
    await refreshRemoteArtifact(context.workingDir);
    return { kind: "continue" };
  } catch (error) {
    throw new StepExecutionError(`Could not refresh artifact: ${(error as Error).message}`);
  }
}
```

The step is retried once; a second `StepExecutionError` halts the task with its message. Any other thrown error goes to the normal task failure handling.

A failing check is not a transient error. Return `halt` (or `repeat`) for a failed test, a policy violation, or a negative review instead of throwing.

## Loading plugins and resolving paths

`plugins` accepts module paths and package names. Where they resolve depends on where the pipeline is declared:

| Declared in               | Relative paths and package names resolve from |
| ------------------------- | --------------------------------------------- |
| Workspace `pipeline_file` | The directory containing the pipeline file (this also applies to `verify` prompt paths). |

Install a shared plugin's dependencies next to the file that declares it. For a workspace file at `~/.devintern/pipelines/backend.json`, run `cd ~/.devintern/pipelines && bun add <package>` and keep relative modules such as `./steps/check-policy.ts` there.

A plugin published to npm is referenced by package name; its entry module must default-export a `StepDefinition`:

```json
{ "plugins": ["@acme/devintern-steps"], "steps": [] }
```

## Examples

Complete, tested examples live in [`examples/pipeline-plugins/`](https://github.com/getdevintern/devintern/tree/main/examples/pipeline-plugins/README.md):

| Example                                         | Shows                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `run-tests`                                     | Run a Bun command in `context.workingDir` and halt on a non-zero exit.                   |
| `check-policy`                                  | Block newly added files under forbidden paths.                                           |
| `verify-artifacts`                              | Require a generated file and expose it through `context.results`.                        |
| `transient-retry`                               | `StepExecutionError` retry compared with a permanent halt.                               |
| `agent-review`                                  | `getDiff`, `runAgentPrompt`, `parseReviewFeedback`, and `filterByPriority` with a bounded repeat. |
| `pr-explainer-narrative`, `pr-explainer-visual` | Diff-based change explanations captured as artifacts before `finalize`.                  |
| `pr-explainer-image`                            | Generate a PNG, upload it with the Files SDK uploader, and embed it in the PR comment.   |

Run all of them with `bun run examples/pipeline-plugins/run-tests.ts`. The public API is exported from `@getdevintern/code/pipeline` ([source](https://github.com/getdevintern/devintern/blob/main/packages/code/src/lib/task/pipeline-api.ts)).
