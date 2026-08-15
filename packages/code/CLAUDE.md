# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

`@getdevintern/code` - AI tool for automatically implementing JIRA tasks using Claude Code. Supports single/batch task processing via JQL queries, fetches JIRA details, formats for Claude, and automates git workflow + PR creation.

## Architecture

### Core Components

- **[src/index.ts](src/index.ts)** - Main entry, CLI parsing, orchestrates workflow: fetch → format → git → claude → commit → PR
- **[src/lib/task-tracker-client.ts](src/lib/task-tracker-client.ts)** - Interface for all task tracker clients (JIRA, Linear, Trello, etc.)
- **[src/lib/task-tracker-manager.ts](src/lib/task-tracker-manager.ts)** - Factory that resolves the concrete tracker from the `TASK_TRACKER` environment variable (defaults to JIRA)
- **[src/lib/trackers/jira/jira-task-tracker-client.ts](src/lib/trackers/jira/jira-task-tracker-client.ts)** - JIRA implementation of `TaskTrackerClient`; delegates HTTP to `JiraClient` and issue parsing to `@devintern/task-trackers`
- **[src/lib/trackers/jira/jira-formatter.ts](src/lib/trackers/jira/jira-formatter.ts)** - JIRA-specific ADF comment formatting for @devintern/code automation
- **[src/lib/task-formatter.ts](src/lib/task-formatter.ts)** - Formats task tracker data (ADF/HTML → Markdown) for LLM prompts
- **[src/lib/utils.ts](src/lib/utils.ts)** - Git operations, file handling utilities
- **[src/lib/github-reviews.ts](src/lib/github-reviews.ts)** - GitHub API client for PR reviews
- **[src/lib/review-formatter.ts](src/lib/review-formatter.ts)** - Formats PR review feedback for Claude
- **[src/lib/address-review.ts](src/lib/address-review.ts)** - Handles PR review responses
- **[src/lib/auto-review-loop.ts](src/lib/auto-review-loop.ts)** - Automatic PR self-review and improvement loop; exports the `runAgentPrompt` / `parseReviewFeedback` / `filterByPriority` / `getPRDiff` primitives reused by pipeline steps
- **[src/lib/pipeline/](src/lib/pipeline/)** - Extensible task pipeline (types, registry, runner, config, built-in steps); public plugin API via the `@getdevintern/code/pipeline` subpath export
- **[src/lib/project-settings.ts](src/lib/project-settings.ts)** - settings.json loading + per-project status resolution (extracted from index.ts so steps avoid an import cycle)
- **[src/lib/clarity-check.ts](src/lib/clarity-check.ts)** - Pre-implementation feasibility assessment (`runClarityCheck`)
- **[src/lib/errors.ts](src/lib/errors.ts)** - `UsageLimitError` (aborts a batch; re-thrown by the pipeline runner, never retried)
- **[src/webhook-server.ts](src/webhook-server.ts)** - Webhook server for automated PR review handling
- **[src/types/](src/types/)** - TypeScript interfaces
  - `task-tracker.ts` - Platform-agnostic domain types (`Task`, `Comment`, `FormattedTaskDetails`, etc.)
  - `jira.ts` - JIRA-specific type aliases (re-exports generic types for backward compatibility)
### Key Workflows

**JIRA Task Processing:**

1. Fetch JIRA details → 2. Transition to "In Progress" → 3. Create `feature/{task-key}` branch → 4. Run clarity check → 5. Execute Claude → 6. Commit changes → 7. Create PR (optional) → 8. Auto-review loop (optional) → 9. Post summary to JIRA

**Auto-Review Loop** (with `--auto-review` flag):

1. Fetch PR diff → 2. Run Claude to review code (JSON feedback) → 3. Parse feedback by priority → 4. Address critical/high/medium issues → 5. Commit & push fixes → 6. Repeat up to N iterations (default: 5) or until approved

**PR Review Handling:**

1. Webhook receives review → 2. Check bot mention → 3. Queue review → 4. Switch worktree to PR branch → 5. Fetch comments → 6. Run Claude → 7. Commit fixes → 8. Push & reply

### Pipeline & Steps

Task execution (everything after the `processSingleTask` preamble: fetch → clarity check → branch → In-Progress transition) runs through an ordered pipeline of steps sharing one mutable `TaskContext` (`src/lib/pipeline/`).

**Default pipeline** (used when `settings.pipeline` is absent; reproduces the classic flow):

```
implement → commit → auto-review → finalize
```

- `implement` — runs the agent (`runImplementation`); consumes `ctx.loopbackFeedback` / `ctx.pendingPromptOverride` as prompt overrides
- `commit` — commit with git-hook auto-fix retries; detects plan-only output and loops back to `implement` once with a "now implement the plan" prompt
- `auto-review` — self-gates on `--auto-review`; validates pre-push hook, runs `runAutoReviewLoop({ skipPush: true })`, re-validates
- `finalize` — hook validation (if not already done) → push → tracker comment → PR creation → status transition
- `clarity` and `verify` are registered but **not** in the default list. The preamble clarity check in `processSingleTask` still runs before branch creation; the `clarity` step exists for custom pipelines. `verify` is the opt-in requirements checker.

**Commit ordering matters:** `commit` must run before `auto-review`/`verify` because both diff `origin/<base>...HEAD`; uncommitted changes would be invisible.

**Failure model (two channels):**

- Execution errors (subprocess crash, unparseable verdict JSON) — steps **throw** `StepExecutionError`; the runner retries the step (default 1 retry) then halts.
- Verdict failures (requirements genuinely unmet) — steps **return** `status: "loopback"` with `ReviewFeedback`; the runner jumps back to `loopbackTo` (default `implement`), bounded by `maxLoopbacks`, then halts.
- `Halt` with `haltKind: "incomplete"` (default) triggers the `onHalt` callback (incomplete-implementation comment + revert to To Do); `haltKind: "stop"` stops quietly (e.g. unfixable pre-push hook).
- `UsageLimitError` is always re-thrown so a batch aborts (never retried).

**User extensibility (two tiers), via `settings.pipeline`:**

1. Declarative: `pipeline.steps: [{ "use": "verify", "onFail": "loopback", "minSeverity": "high", "maxIterations": 3 }, ...]` — any number of `verify` instances with different `prompt`/`onFail`/`minSeverity`.
2. Code plugins: `pipeline.plugins: ["./.devintern-code/steps/my-step.ts", "@org/pkg"]` — each module default-exports a `StepDefinition`; loaded via dynamic `import()` before step resolution, registered in the same registry as built-ins (name collisions error out). Typed API surface: `@getdevintern/code/pipeline` (exports live at `src/lib/pipeline/index.ts`; `src/**` ships in the npm tarball for this reason).

`runAgentHarness` in `src/index.ts` remains as a thin back-compat shim: it builds the `TaskContext`, loads plugins, resolves the pipeline (default when unconfigured), and runs it — preserving the old contract (resolves for normal/incomplete/max-turns so batches continue; rejects on timeout, non-zero exit, and `UsageLimitError`).

### Configuration

**Environment Variables (.devintern-code/.env):**

- `TASK_TRACKER` - Task tracker type: `jira` (default), `linear`, `github`, `azure-devops`, `asana`, `trello`, or `markdown`
- `ASANA_API_TOKEN` - Asana personal access token (required when `TASK_TRACKER=asana`); optional `ASANA_DEFAULT_PROJECT_GID`, `ASANA_STORY_POINTS_FIELD`
- `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_PROJECT` - Azure DevOps credentials (required when `TASK_TRACKER=azure-devops`)
- `LINEAR_API_KEY` - Linear personal API key (required when `TASK_TRACKER=linear`)
- `GITHUB_REPO` - Target `owner/repo` for GitHub Issues (required when `TASK_TRACKER=github`; reuses `GITHUB_TOKEN`)
- `GITHUB_STATUS_LABELS` - Optional comma-separated mutually-exclusive status label names for GitHub transitions
- `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` - JIRA credentials
- `TRELLO_API_KEY`, `TRELLO_API_TOKEN` - Trello credentials (required when `TASK_TRACKER=trello`)
- `TRELLO_DEFAULT_BOARD_ID` - Optional Trello board ID for settings lookup and status transitions
- `GITHUB_TOKEN` or `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_PATH` - GitHub auth
- `BITBUCKET_TOKEN` - Bitbucket auth
- `WEBHOOK_SECRET` - GitHub webhook verification
- `DEVINTERN_OUTPUT_DIR` - Output directory (default: `/tmp/devintern-tasks`)
- `AGENT_SANDBOX` - OS-level sandbox for spawned agent processes: `none` (default), `auto`, `native`, `nono`, `srt`, `docker`, or `smolvm`; overridden per-run by the `--sandbox <name>` CLI flag. Run `devintern sandbox` for a doctor report (detected providers, setup steps, what `auto` would pick)
- `AGENT_SANDBOX_WRITABLE_PATHS` - Extra paths (beyond the project workspace) the sandbox allows writes to
- `AGENT_SANDBOX_ALLOWED_DOMAINS` - Extra network allowlist entries for sandbox providers that restrict egress (e.g. `srt`)
- `AGENT_SANDBOX_NONO_PROFILE` - Overrides the `nono` provider's isolation profile

**Project Settings (.devintern-code/settings.json):**

Tracker-specific sections are supported. The tool resolves configuration based on the `TASK_TRACKER` environment variable (default: `jira`).

```json
{
  "jira": {
    "projects": {
      "PROJ": {
        "inProgressStatus": "In Progress",
        "todoStatus": "To Do",
        "prStatus": "In Review",
        "storyPointsField": "customfield_10016"
      }
    }
  },
  "linear": {
    "projects": {
      "ENG": {
        "inProgressStatus": "In Progress",
        "todoStatus": "Backlog",
        "prStatus": "In Review"
      }
    }
  }
}
```

Legacy top-level `projects` is still honored as a Jira fallback for backward compatibility.

Everything under the output directory is a write-only debug artifact. Durable state (webhook queue, worker cursors, run records, retry state) lives in `.devintern-code/queue.db`. The config directory is found by walking up from the cwd (same traversal as `.env`), so a run started inside a package still uses the project's database; the tool also keeps that database out of git (via `.git/info/exclude`) and out of every `git clean`/`git stash` it runs, because deleting it under an open connection fails later writes with "disk I/O error". The retry gate (`src/lib/retry-gate.ts`) skips a task only when a previous attempt was reported incomplete and neither the description nor the comments changed since (`--force` bypasses).

## Key Implementation Details

- **Runtime**: Bun (required for bun:sqlite in webhook queue)
- **Git branches**: `feature/{task-key-lowercase}` naming convention
- **Claude execution**: Spawns subprocess with `-p --dangerously-skip-permissions` for implementation; internal analysis-only spawns (clarity check, estimation) currently use the same unattended path (`PREFER_READONLY_ANALYSIS` is off in `lib/analysis-mode.ts` — harness ask/plan modes often return unusable stdout). The read-only prefer + fallback path is kept for re-enable later
- **JIRA integration**: Posts summaries in Atlassian Document Format
- **Webhook isolation**: Sequential queue + branch-scoped worktrees at `/tmp/devintern-review-worktree-<branch>/`
  - One worktree per PR branch (reused across reviews of the same branch; other branches pruned to bound disk usage)
  - Branch scoping is also a safety property: the base path `/tmp/devintern-review-worktree` is what project test suites target, so a PR whose own tests call `prepareReviewWorktree` (e.g. devintern reviewing its own PRs) can never delete the worktree the review is running in
  - Automatically cleans up stale worktree registrations from old paths (e.g., `.devintern-code/review-worktree/`)
- **Dependency installation**: Auto-detects package managers (bun/pnpm/npm/poetry/etc.) when preparing worktrees
