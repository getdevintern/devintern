---
title: "Customizing the Task Pipeline"
sidebarLabel: "Pipelines"
description: "Add verification and project-local TypeScript steps to task delivery, and customize the pipeline per repository or across a fleet."
section: "Automation"
order: 5
dateModified: 2026-10-14
---

# Customizing the Task Pipeline

Task delivery runs a configurable pipeline. Out of the box it is:

```
implement → commit → auto-review → finalize
```

- `implement` runs the coding agent and writes an implementation summary.
- `commit` stages and commits the work (with agent repair of failing git hooks).
- `auto-review` critiques the committed diff locally and applies fixes (only
  when `--auto-review` is set).
- `finalize` pushes the branch, posts the implementation summary to the task,
  and opens the pull request (only when `--create-pr` is set).

Branch preparation, the feasibility check, and the In Progress transition still
happen before this pipeline. You customize delivery by adding a `pipeline`
section to `.devintern-code/settings.json`, or by pointing a workspace at a
standalone pipeline file.

> Project-local only. The current release customizes the pipeline **inside a
> repository** (`.devintern-code/settings.json`) or through a workspace
> `pipeline_file`. There are no project-wide workspace `pipeline` settings
> beyond those files.

## Where a task gets its pipeline

A task subprocess can see up to four layers, and **exactly one complete
definition runs** — ordered step arrays are never merged across scopes:

1. **Workspace per-repository override** — `pipeline_file` on a `[[repos]]`
   entry in `workspace.toml` (highest).
2. **Repository settings** — the `pipeline` block in the repository's committed
   `.devintern-code/settings.json`.
3. **Workspace default** — `pipeline_file` on `[defaults]` in `workspace.toml`.
4. **Built-in default** — `implement → commit → auto-review → finalize`.

A referenced workspace file that is missing or invalid fails the run, naming the
repository and the file; it never silently falls back. See
[Workspaces (Multi-Repo Fleet) → Pipelines for the fleet and per repository](./workspaces.md#pipelines-for-the-fleet-and-per-repository)
for the `workspace.toml` reference and live-reload behavior.

## Required ordering

`pipeline.steps` is validated before the agent starts:

- `clarity` may appear **once, first**, before `implement`.
- `implement` must appear **once**, before every delivery step.
- `commit` must appear **once**.
- `verify` and `auto-review` must **follow `commit`**.
- `finalize` must be **last**; nothing may follow it.
- Custom plugin steps may run **after `implement` and before `finalize`** —
  including before `commit`.

The `clarity` marker only reserves its position. It does **not** control whether
the feasibility preamble runs: `--skip-clarity-check` still decides that, exactly
as before. If you omit `clarity` from the list, the preamble still runs unless
the flag is passed.

## Built-in steps and CLI flags

These flags keep their existing, operator-controlled meaning:

| Flag                     | Effect on the pipeline                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `--skip-clarity-check`   | Skips the pre-implementation feasibility preamble (also affected by the `clarity` marker position). |
| `--auto-review`          | Lets the `auto-review` step run its review–fix loop. Without it, that step is a no-op.  |
| `--create-pr`            | Lets `finalize` push and open the PR. Without it, `finalize` only posts a summary comment. |
| `--auto-review-iterations N` | Caps the auto-review loop (default from `AUTO_REVIEW_ITERATIONS`, else `2`).        |

Pre-push hook validation still runs before publication whether or not
`auto-review` is present: the `auto-review` step validates it, and `finalize`
validates it if no earlier step did.

Verification is enabled by adding `{ "use": "verify" }` to the pipeline; there is
no standalone `--verify` flag in the current CLI. `verify` can be declared more
than once with different prompts (a functional check and a security check, for
example).

## Built-in verification (`verify`)

`verify` asks the configured agent whether the **committed diff** satisfies the
task's functional requirements. It is agent-based semantic verification; for a
deterministic gate use a [custom step that runs a command](#deterministic-checks-vs-agent-verification)
instead.

```json
{
  "pipeline": {
    "steps": [
      { "use": "implement" },
      { "use": "commit" },
      { "use": "verify", "prompt": "./prompts/verify-functional.md", "onFail": "loopback", "minSeverity": "high", "maxIterations": 3 },
      { "use": "verify", "prompt": "./prompts/verify-security.md", "onFail": "warn", "minSeverity": "critical" },
      { "use": "auto-review" },
      { "use": "finalize" }
    ]
  }
}
```

| Option          | Default      | Meaning                                                              |
| --------------- | ------------ | -------------------------------------------------------------------- |
| `prompt`        | bundled default | Inline instructions, or a path to a prompt file.                 |
| `minSeverity`   | `"high"`     | Lowest priority that blocks: `critical`, `high`, `medium`, `low`, `info`. |
| `maxIterations` | `3`          | Bound on repair cycles when `onFail` is `loopback`.                   |
| `onFail`        | `"loopback"` | `loopback`, `halt`, or `warn`.                                        |

`prompt` resolves like the catalog overrides: a relative string is treated as a
file path when a file of that name exists next to the declaring configuration;
otherwise it is used verbatim as inline instructions. A misspelled path
therefore does not fail the run — it either silently picks up a same-named file
in the repository or becomes a literal prompt, so confirm the file resolves.

**On a failed verdict:**

- `loopback` (default) — the agent is asked to repair the findings, the repair
  is committed, and verification runs again, up to `maxIterations` cycles.
- `halt` — the task is marked incomplete, reported to the tracker, and returned
  to its To Do status. Nothing is pushed.
- `warn` — the findings are recorded as warnings and delivery continues.

**Malformed verdicts.** Findings are validated before priority filtering.
Unknown priorities, malformed findings, and an `approved: true` that contradicts
medium-or-higher findings are rejected. A transient diff, agent, or JSON failure
is retried once; two failures halt with `Verification failed twice: …`. Account
usage limits propagate immediately to worker failover. If no valid verdict can be
obtained, the task is marked incomplete before any push.

**Git disabled.** With `--no-git`, `verify` records `verify skipped: git
workflow disabled` because there is no committed diff.

### Runnable verification example

`settings.json` fragment with a separate prompt file and a separate security
check:

```json
{
  "pipeline": {
    "steps": [
      { "use": "implement" },
      { "use": "commit" },
      { "use": "verify", "prompt": "./prompts/verify.md", "onFail": "loopback", "minSeverity": "high", "maxIterations": 2 },
      { "use": "verify", "prompt": "Only flag security regressions; ignore style.", "onFail": "warn", "minSeverity": "critical" },
      { "use": "finalize" }
    ]
  }
}
```

`prompts/verify.md`:

```markdown
Verify whether the committed diff satisfies the task's acceptance criteria.
Report each unmet requirement as a `high` or `critical` item and return the JSON
verdict shape only. Do not report style preferences.
```

Run it and inspect the artifacts:

```bash
devintern PROJ-123 --create-pr
# Artifacts land in the task output directory (default /tmp/devintern-tasks/<task-key>):
#   verify-prompt.txt       the exact prompt sent to the agent
#   verify-feedback.json    the parsed verdict
```

To see the three policies, change `onFail`: `loopback` repairs and re-verifies
(bounded by `maxIterations`), `halt` stops before pushing and returns the task to
To Do, and `warn` records the findings and continues to `finalize`.

### Deterministic checks vs agent verification

`verify` is semantic and model-driven. When a check can be expressed as a
command or an invariant, prefer a deterministic plugin step — it is faster,
cheaper, and reproducible. The [`run-tests`](#examples) example
runs a real Bun command and halts on a non-zero exit; `check-policy` blocks
forbidden added files; `verify-artifacts` validates a generated artifact's
schema. Mix them freely: deterministic gates first, agent verification last.

## Custom plugin steps

A custom step is a project-relative module or installed package listed under
`pipeline.plugins`. The module **default-exports** a `StepDefinition`:

```ts
import { StepExecutionError } from "@getdevintern/code/pipeline";
import type { PipelineContext, StepDefinition, TaskStepResult } from "@getdevintern/code/pipeline";

const definition: StepDefinition = {
  name: "check-policy",
  create(config) {
    // Called once at pipeline resolution with the step's options.
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

Register it:

```json
{
  "pipeline": {
    "plugins": ["./.devintern-code/steps/check-policy.ts"],
    "steps": [
      { "use": "implement" },
      { "use": "commit" },
      { "use": "check-policy", "dryRun": false },
      { "use": "finalize" }
    ]
  }
}
```

Rules:

- A step name must be unique and non-empty, may not **replace** a reserved name
  (`clarity`, `implement`, `commit`, `verify`, `auto-review`, `finalize`,
  `publish`, `repair`), and may not start with `__`.
- A given plugin step may appear only once in a configured pipeline.
- `create(config)` receives the step entry's options (minus `use`). Unknown or
  invalid options are the plugin's responsibility to validate.

### `PipelineContext`

The `context` passed to `run` is the same object across all steps and carries:

| Field | Meaning |
| ----- | ------- |
| `taskKey`, `taskSummary`, `task`, `tracker` | Task identity and tracker client (may be undefined for markdown inputs). |
| `projectSettings` | Parsed `.devintern-code/settings.json`, or `null`. |
| `taskContent` | The formatted task prompt the agent received. |
| `taskFile` | Path to the formatted task file. |
| `workingDir` | The repository worktree the task runs in. |
| `outputDir` | The task artifact directory. |
| `output` | The implementation output (agent stdout). |
| `committed` | Whether the implementation has been committed. |
| `prTargetBranch` | Base branch for the PR/diff. |
| `enableGit`, `createPr`, `skipComments`, `autoReview` | Effective run flags. |
| `autoReviewIterations`, `maxTurns` | Caps. |
| `warnings` | Accumulated warning strings (`warn` results append here). |
| `results` | Every step record so far: `{ step, result }`, including `data`. |
| `loopbackFeedback`, `loopbackReason` | Set by a `repeat` for the next run. |
| `runAgentPrompt(prompt)` | Run the configured agent and return its stdout. |
| `getDiff()` | Unified diff against `prTargetBranch`. |
| `parseReviewFeedback(output)` | Parse and validate a JSON review verdict. |
| `filterByPriority(items, min)` | Filter findings at or above a priority. |

`data` on a step result is how steps communicate: a later step reads
`context.results` to find an earlier step's `data`. Plugins execute **inside the
task process**, with that process's environment, credentials, and permissions —
the same access your coding agent has.

### Step results

`run` returns (or, returning nothing, implies `continue`):

| Result | Shape | Effect |
| ------ | ----- | ------ |
| continue | `{ kind: "continue", data? }` | Proceed to the next step. |
| warn | `{ kind: "warn", reason, data? }` | Record a warning (`context.warnings`) and continue. |
| halt | `{ kind: "halt", reason, haltKind?, data? }` | Stop. Default marks the task incomplete; `haltKind: "stop"` stops delivery without changing the task's status and without posting tracker feedback. |
| repeat | `{ kind: "repeat", from, maxRepeats, reason?, feedback? }` | Re-execute from an earlier step, bounded by `maxRepeats`. |

`repeat` details:

- `from` must name an **earlier** step in the sequence. Re-executing runs that
  step **and every step after it**, up to and including the repeating step.
  `repeat` from `implement` therefore re-runs `implement`, `commit`, and every
  remaining step before the diff is checked again.
- `maxRepeats` is a positive integer bound counted per repeating step. When it is
  exceeded the pipeline halts with
  `Task step '<name>' exceeded its repeat limit (<n>)`.
- `feedback` (a `ReviewFeedback`) is exposed to the re-run through
  `context.loopbackFeedback`; the built-in `implement` and `verify` steps build a
  repair prompt from it.
- The built-in `verify` loopback does **not** repeat `implement`. It repeats its
  private `__repair-<n>` step, which runs the agent repair and recommits, then
  runs `verify` again. A custom step that wants a full re-implementation repeats
  from `implement`.

A plugin that **mutates files after `commit`** must ensure they are committed
before publication: return `{ kind: "repeat", from: "commit", maxRepeats: 1 }`
(or repeat from `implement`) so the `commit` step runs again. Prefer placing
mutating steps **before** `commit` when possible.

### Transient retries with `StepExecutionError`

Throw `StepExecutionError` for a transient execution failure that deserves one
retry (a flaky remote, a momentarily missing dependency):

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

The runner retries the **same step once**. A second `StepExecutionError` halts
with the error message; any other thrown error propagates to the task's existing
failure handler (including account-wide usage limits).

A **failing check is not a transient error.** A failed test, a policy violation,
or a negative review verdict is a permanent finding: return
`{ kind: "halt" }` (or `repeat`) instead of throwing. The
[`transient-retry`](#examples) example shows both shapes.

## Loading plugins and resolving paths

Plugins are listed as module paths or package names. Resolution depends on where
the pipeline is declared:

- **`.devintern-code/settings.json`** — relative paths and package names resolve
  against the **repository root** (the task working directory).
- **Workspace `pipeline_file`** — relative `plugins` and `verify.prompt` paths
  are made absolute against the **directory containing the pipeline file**.
  Package names resolve from that same base.

Consequently, a shared plugin's dependencies must be installed **next to the
declaring file**. For a workspace file at `~/.devintern/pipelines/backend.json`,
install with `cd ~/.devintern/pipelines && bun add <package>` and place relative
modules (for example `./steps/check-policy.ts`) there too.

**Installed-package plugins.** A plugin published to npm is referenced by package
name and resolved with `Bun.resolveSync` from the declaring configuration's
directory:

```json
{ "pipeline": { "plugins": ["@acme/devintern-steps"], "steps": [ /* … */ ] } }
```

The package's entry module must default-export a `StepDefinition`, exactly like a
project-local file. Community plugins live in their own repositories; this
project does not host or endorse a plugin marketplace.

## Two repositories, two pipelines

Each managed repository can run a completely different pipeline. Commit the
configuration to the repository so the worker picks it up.

`backend/.devintern-code/settings.json`:

```json
{
  "pipeline": {
    "plugins": ["./.devintern-code/steps/run-tests.ts"],
    "steps": [
      { "use": "implement" },
      { "use": "commit" },
      { "use": "run-tests", "args": ["test", "--filter", "unit"] },
      { "use": "verify", "onFail": "loopback" },
      { "use": "finalize" }
    ]
  }
}
```

`frontend/.devintern-code/settings.json`:

```json
{
  "pipeline": {
    "plugins": ["./.devintern-code/steps/check-policy.ts"],
    "steps": [
      { "use": "implement" },
      { "use": "commit" },
      { "use": "check-policy", "forbiddenPaths": ["public/secrets/"] },
      { "use": "auto-review" },
      { "use": "finalize" }
    ]
  }
}
```

`workspace.toml`:

```toml
[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"
```

What to expect:

- The worker manages **bare clones** under `~/.devintern/repos/` and runs each
  task in a fresh, disposable **worktree** under `~/.devintern/worktrees/`. The
  pipeline it selects is the one committed in that worktree.
- Each task runs in its **own CLI subprocess**, so plugin registries and
  selections never leak between tasks or repositories.
- Editing files only in a **personal checkout** (for example `~/code/backend`)
  does **not** affect managed runs: the worker clones and checks out its own
  copies. Commit the pipeline (and its plugin/prompt files) to the repository, or
  put the definition in a workspace `pipeline_file`.
- A `[[repos]].pipeline_file` on either repository overrides its committed
  `settings.json`; a `[defaults].pipeline_file` applies only when the repository
  declares neither.

## Examples

Complete, runnable examples live under
[`examples/pipeline-plugins/`](https://github.com/getdevintern/devintern/tree/main/examples/pipeline-plugins):

| Example | Demonstrates |
| ------- | ------------ |
| `run-tests` | Run a real Bun command in `context.workingDir`, await completion, halt on non-zero exit. |
| `check-policy` | Inspect changed files against the PR target and block forbidden additions. |
| `verify-artifacts` | Require a generated artifact and expose it through `context.results`. |
| `transient-retry` | `StepExecutionError` single-retry vs a permanent halt. |
| `agent-review` | `getDiff`/`runAgentPrompt`/`parseReviewFeedback`/`filterByPriority` with a bounded repeat. |
| `pr-explainer-narrative`, `pr-explainer-visual` | Diff-grounded explanation artifacts written before `finalize`. |

Run the whole suite with `bun run examples/pipeline-plugins/run-tests.ts`.

## Source of truth

These files implement the behavior described above:

- [`pipeline-config.ts`](https://github.com/getdevintern/devintern/blob/main/packages/code/src/lib/task/pipeline-config.ts) — default pipeline, ordering validation, plugin loading.
- [`pipeline-registry.ts`](https://github.com/getdevintern/devintern/blob/main/packages/code/src/lib/task/pipeline-registry.ts) — `StepDefinition`, `PipelineContext`, reserved names, `StepExecutionError`.
- [`step-runner.ts`](https://github.com/getdevintern/devintern/blob/main/packages/code/src/lib/task/step-runner.ts) — step results, repeat bounds, transient retry.
- [`run-harness-finalize.ts`](https://github.com/getdevintern/devintern/blob/main/packages/code/src/lib/agent/run-harness-finalize.ts) — delivery steps (`commit`, `auto-review`, `finalize`) and `haltKind`.
- [`verify.ts`](https://github.com/getdevintern/devintern/blob/main/packages/code/src/lib/agent/verify.ts) — verification policies and repair prompts.
- [`pipeline-selection.ts`](https://github.com/getdevintern/devintern/blob/main/packages/code/src/lib/task/pipeline-selection.ts) — workspace/repository precedence.
- [`pipeline-api.ts`](https://github.com/getdevintern/devintern/blob/main/packages/code/src/lib/task/pipeline-api.ts) — the public `@getdevintern/code/pipeline` surface.

The explainer examples' prompt guidance is adapted from public skill
repositories; pinned revisions and attribution are in the example `CREDITS.md`
files. Feeding an explanation artifact into the published PR body is not yet
supported by the public API and is tracked as a follow-up.
