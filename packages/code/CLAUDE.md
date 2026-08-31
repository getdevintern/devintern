# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

`@getdevintern/code` - AI tool for automatically implementing JIRA tasks using Claude Code. Supports single/batch task processing via JQL queries, fetches JIRA details, formats for Claude, and automates git workflow + PR creation.

## Architecture

### Key Workflows

**JIRA Task Processing:**

1. Fetch JIRA details → 2. Transition to "In Progress" → 3. Create `feature/{task-key}` branch → 4. Run clarity check → 5. Execute Claude → 6. Commit changes → 7. Create PR (optional) → 8. Auto-review loop (optional) → 9. Post summary to JIRA

**Auto-Review Loop** (with `--auto-review` flag):

1. Fetch PR diff → 2. Run Claude to review code (JSON feedback) → 3. Parse feedback by priority → 4. Address critical/high/medium issues → 5. Commit & push fixes → 6. Repeat up to N iterations (default: 5) or until approved

**PR Review Handling:**

1. Webhook receives review → 2. Check bot mention → 3. Queue review → 4. Switch worktree to PR branch → 5. Fetch comments → 6. Run Claude → 7. Commit fixes → 8. Push & reply

### Configuration

**Environment Variables (.devintern-code/.env):**

- `TASK_TRACKER` - Task tracker type: `jira` (default), `linear`, `github`, `gitlab`, `azure-devops`, `asana`, `trello`, or `markdown`
- `ASANA_API_TOKEN` - Asana personal access token (required when `TASK_TRACKER=asana`); optional `ASANA_DEFAULT_PROJECT_GID`, `ASANA_STORY_POINTS_FIELD`
- `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_PROJECT` - Azure DevOps credentials (required when `TASK_TRACKER=azure-devops`)
- `LINEAR_API_KEY` - Linear personal API key (required when `TASK_TRACKER=linear`)
- `GITHUB_REPO` - Target `owner/repo` for GitHub Issues (required when `TASK_TRACKER=github`; requires `GITHUB_TOKEN`, App credentials cannot substitute)
- `GITHUB_STATUS_LABELS` - Optional comma-separated mutually-exclusive status label names for GitHub transitions
- `GITLAB_TOKEN`, `GITLAB_PROJECT`, `GITLAB_BASE_URL` - GitLab credentials (required when `TASK_TRACKER=gitlab`; base URL optional, defaults to https://gitlab.com)
- `GITLAB_STATUS_LABELS` - Optional comma-separated mutually-exclusive status label names for GitLab transitions
- `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` - JIRA credentials
- `TRELLO_API_KEY`, `TRELLO_API_TOKEN` - Trello credentials (required when `TASK_TRACKER=trello`)
- `TRELLO_DEFAULT_BOARD_ID` - Optional Trello board ID for settings lookup and status transitions
- `GITHUB_TOKEN` - Personal / interactive GitHub PAT (required for `TASK_TRACKER=github`; enough for free CLI PRs and own-PR review polling)
- `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_PATH` or `GITHUB_APP_PRIVATE_KEY_BASE64` - Team / unattended-automation GitHub App (required for `@mention` matching and `slug[bot]` commits; CLI uses token first, `devintern webhook serve` uses App first). See https://devintern.com/pricing/
- `BITBUCKET_TOKEN` - Bitbucket auth
- `PR_LABELS` - Optional comma-separated labels applied to created PRs (GitHub only). Set per repo in workspace.toml (`pr_labels`) for fleet mode
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

Everything under the output directory is a write-only debug artifact. Durable state (webhook queue, worker cursors, run records, retry state, addressed PR feedback) lives in `.devintern-code/queue.db`. The config directory is found by walking up from the cwd (same traversal as `.env`), so a run started inside a package still uses the project's database; the tool also keeps that database out of git (via `.git/info/exclude`) and out of every `git clean`/`git stash` it runs, because deleting it under an open connection fails later writes with "disk I/O error". The retry gate (`src/lib/retry-gate.ts`) skips a task only when a previous attempt was reported incomplete and neither the description nor the comments changed since (`--force` bypasses).

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

## Testing: state database isolation

Tests must never touch a developer's real `.devintern-code/queue.db` (webhook queue, worker cursors, run records, retry state, addressed PR feedback). Three layers enforce this:

1. `tests/run-tests.ts` (the `bun run test` entry) sets `WEBHOOK_QUEUE_DB` to a temp path before launching `bun test`, so even subprocesses spawned without an explicit env option inherit a safe value.
2. `tests/setup/guard-queue-db.ts` (bunfig preload) re-pins `WEBHOOK_QUEUE_DB` to a unique mkdtemp db per test-file process, covering every default-resolution code path (`new RunStore()`, `new WorkerState()`, `resolveQueueDbPath()`), and removes it at exit. Bun children that thread `{ ...process.env }` inherit the pin; children without an explicit env option get the start environment, which layer 1 pinned.
3. The same preload hashes every `.devintern-code/queue.db` reachable by the ancestor walk from cwd and fails the suite if one is created, deleted, or mutated.

When adding tests, keep following the per-test pattern in `webhook-queue.test.ts` / `worker-state.test.ts`: create a unique `mkdtempSync` directory under `os.tmpdir()`, pass an explicit `dbPath` / set `WEBHOOK_QUEUE_DB`, and clean up in `afterEach`. `AutomationStateStore` has no default path and requires an explicit argument by design. See `tests/state-db-isolation.test.ts` for the contract these guarantees make.
