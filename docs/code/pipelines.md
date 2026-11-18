---
title: "Customizing the Task Pipeline"
sidebarLabel: "Pipelines"
description: "Use when adding verification or custom TypeScript steps to task delivery, or giving repositories different pipelines across a fleet."
section: "Automation Reference"
order: 2
dateModified: 2026-11-18
---

# Customizing the Task Pipeline

Task delivery runs a configurable pipeline. Out of the box it is:

```
implement → commit → auto-review → finalize
```

- `implement` runs the coding agent and writes an implementation summary.
- `commit` stages and commits the work, asking the agent to fix failing git hooks.
- `auto-review` reviews the committed diff and applies fixes (only with `--auto-review`).
- `finalize` pushes the branch, posts the summary to the task, and opens the pull request (only with `--create-pr`).

Branch preparation, the feasibility check, and the In Progress transition happen before the pipeline. To change it, add a `pipeline` section to the repository's `.devintern-code/settings.json`, or point a workspace at a standalone pipeline file. To write your own TypeScript steps, see [Writing pipeline plugin steps](./pipeline-plugins.md).

## Where a task gets its pipeline

Exactly one complete definition runs. Step lists are never merged across scopes. From highest to lowest precedence:

1. `pipeline_file` on a `[[repos]]` entry in `workspace.toml`.
2. The `pipeline` block in the repository's committed `.devintern-code/settings.json`.
3. `pipeline_file` on `[defaults]` in `workspace.toml`.
4. The built-in default: `implement → commit → auto-review → finalize`.

If a referenced workspace file is missing or invalid, the run fails and names the repository and file; it does not fall back. See [Workspaces → Pipelines for the fleet and per repository](./workspaces.md#pipelines-for-the-fleet-and-per-repository) for the `workspace.toml` reference.

## Required ordering

`pipeline.steps` is validated before the agent starts:

- `clarity` may appear once, first, before `implement`.
- `implement` must appear once, before every delivery step.
- `commit` must appear once.
- `verify` and `auto-review` must come after `commit`.
- `finalize` must be last.
- Custom plugin steps may run anywhere after `implement` and before `finalize`, including before `commit`.

The `clarity` marker only reserves a position. Whether the feasibility check runs is still decided by `--skip-clarity-check`; omitting `clarity` does not skip it.

## Built-in steps and CLI flags

| Flag                         | Effect on the pipeline                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `--skip-clarity-check`       | Skips the pre-implementation feasibility check.                                             |
| `--auto-review`              | Lets the `auto-review` step run its review–fix loop. Without it, the step does nothing.     |
| `--create-pr`                | Lets `finalize` push and open the PR. Without it, `finalize` only posts a summary comment.  |
| `--auto-review-iterations N` | Caps the auto-review loop (default from `AUTO_REVIEW_ITERATIONS`, else `2`).                |

Pre-push hooks are validated before publishing whether or not `auto-review` is in the pipeline.

There is no `--verify` flag. Turn verification on by adding `{ "use": "verify" }` to the pipeline. You can add it more than once with different prompts, for example a functional check and a security check.

## Built-in verification (`verify`)

`verify` asks the configured agent whether the committed diff meets the task's requirements. It is a model-driven check; for a reproducible gate, use a [deterministic step](#deterministic-checks-vs-agent-verification).

```json
{
  "pipeline": {
    "steps": [
      { "use": "implement" },
      { "use": "commit" },
      { "use": "verify", "prompt": "./prompts/verify.md", "onFail": "loopback", "maxIterations": 2 },
      { "use": "verify", "prompt": "Only flag security regressions; ignore style.", "onFail": "warn", "minSeverity": "critical" },
      { "use": "auto-review" },
      { "use": "finalize" }
    ]
  }
}
```

| Option          | Default         | Meaning                                                                     |
| --------------- | --------------- | --------------------------------------------------------------------------- |
| `prompt`        | bundled default | Inline instructions, or a path to a prompt file.                            |
| `minSeverity`   | `"high"`        | Lowest priority that blocks: `critical`, `high`, `medium`, `low`, `info`.   |
| `maxIterations` | `3`             | Maximum repair cycles when `onFail` is `loopback`.                          |
| `onFail`        | `"loopback"`    | What happens on a failed verdict: `loopback`, `halt`, or `warn`.            |

On a failed verdict:

- `loopback`: the agent repairs the findings, the repair is committed, and `verify` runs again, up to `maxIterations` times.
- `halt`: the task is marked incomplete, reported to the tracker, and moved back to To Do. Nothing is pushed.
- `warn`: the findings are recorded as warnings and delivery continues.

A relative `prompt` is used as a file path if that file exists next to the declaring configuration; otherwise the string is used as the prompt itself. A misspelled path does not fail the run, so check that the file resolves.

If the agent cannot produce a valid verdict after one retry, the task is marked incomplete before anything is pushed. With `--no-git`, `verify` is skipped because there is no committed diff.

The prompt sent and the parsed verdict are saved as `verify-prompt.txt` and `verify-feedback.json` in the task output directory (default `/tmp/devintern-tasks/<task-key>`), and as the `verification-prompt` and `verification` [artifacts](./artifacts.md) in the dashboard.

### Deterministic checks vs agent verification

`verify` is semantic and model-driven. When a check can be expressed as a command or a rule (run the tests, block forbidden files, validate a generated file), a [plugin step](./pipeline-plugins.md) is faster, cheaper, and reproducible. The [`run-tests`, `check-policy`, and `verify-artifacts` examples](./pipeline-plugins.md#examples) do exactly that. Put deterministic gates first and agent verification after them.

## Different pipelines per repository

Each managed repository can run its own pipeline. Commit the configuration (and any plugin or prompt files) to the repository so the worker picks it up.

`backend/.devintern-code/settings.json`:

```json
{
  "pipeline": {
    "plugins": ["./.devintern-code/steps/run-tests.ts"],
    "steps": [
      { "use": "implement" },
      { "use": "commit" },
      { "use": "run-tests", "args": ["test", "--filter", "unit"] },
      { "use": "verify" },
      { "use": "finalize" }
    ]
  }
}
```

`frontend/.devintern-code/settings.json` could instead use `check-policy` and `auto-review`.

The worker runs each task in its own worktree checked out from the remote, so edits in a personal checkout (for example `~/code/backend`) do not affect managed runs. A `[[repos]].pipeline_file` overrides the repository's committed settings; a `[defaults].pipeline_file` applies only when the repository declares neither. See [Workspaces](./workspaces.md#pipelines-for-the-fleet-and-per-repository) for details.

## Related

- [Writing pipeline plugin steps](./pipeline-plugins.md): custom TypeScript steps, step results, and plugin loading.
- [Pipeline artifacts](./artifacts.md): what steps capture and how to publish it on the PR.
- [Runnable examples](https://github.com/getdevintern/devintern/tree/main/examples/pipeline-plugins).
