# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

@devintern/code - AI tool for automatically implementing JIRA tasks using Claude Code. Supports single/batch task processing via JQL queries, fetches JIRA details, formats for Claude, and automates git workflow + PR creation.

## Development Commands

- `bun start [TASK-KEYS...]` - Run with Bun
- `bun run build` - Build to `dist/` for distribution
- `bun run typecheck` - Type check without compilation
- `bun test` - Run test suite
- `bun run install-global` - Build and install globally for testing

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
- **[src/lib/auto-review-loop.ts](src/lib/auto-review-loop.ts)** - Automatic PR self-review and improvement loop
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

### Output Structure

```
{output-dir}/{task-key}/
├── task-details.md                      # Formatted task for Claude
├── feasibility-assessment.md            # Clarity check results
├── implementation-summary.md            # Success output
├── implementation-summary-incomplete.md # Failure output
├── auto-review-summary.json             # Auto-review loop results
├── iteration-{N}/                       # Auto-review iteration artifacts
│   ├── feedback.json                    # Structured review feedback
│   └── review-prompt.txt                # Prompt sent to Claude
└── attachments/                         # JIRA attachments
```

## Query Language per Tracker

The `--query` flag (canonical) or `--jql` (deprecated alias) passes a query string to the active tracker's `searchTasks()` implementation.

| Tracker | Query Language | Status | Notes |
|---------|---------------|--------|-------|
| **Jira** | JQL | Implemented | `GET /rest/api/3/search/jql`. Example: `project = PROJ AND status = 'To Do'` |
| **Linear** | GraphQL IssueFilter | Implemented | JSON IssueFilter object (e.g. `{"state":{"name":{"eq":"Todo"}}}`) or plain text title search. See https://studio.linear.app/graphql |
| **GitHub Issues** | GitHub search syntax | Implemented | Qualifiers like `is:open label:bug`, auto-scoped to `repo:{GITHUB_REPO} is:issue`. First 100 results |
| **Azure DevOps** | WIQL (SQL-like) | Implemented | `SELECT [System.Id] FROM WorkItems WHERE ...`, scoped to AZURE_DEVOPS_PROJECT, first 100 results |
| **Asana** | Mini-syntax field filters | Implemented | `project:<gid> section:"To Do" assignee:<name> completed:false <text>`; project defaults to `ASANA_DEFAULT_PROJECT_GID`; lists project tasks (first 100) with client-side filtering (workspace search API is Premium-only) |
| **Trello** | Trello search operators | Implemented | `list:"To Do" is:open <text>`, scoped to `TRELLO_DEFAULT_BOARD_ID` when set. First 100 results |
| **Markdown** | Frontmatter filters | Implemented | `status=todo type=bug <text>` matched against frontmatter fields in `MARKDOWN_TASKS_DIR`; free text matches titles |

All trackers support `--query`; the capability map in `src/lib/tracker-capabilities.ts` is the source of truth.

## Testing

- Uses Bun's native test runner (`bun:test` API)
- Tests in `tests/` directory use isolated temp directories for parallel execution
- Import from `bun:test`: `describe`, `test`, `expect`, `beforeEach`, `afterEach`
- Use `beforeEach`/`afterEach` for setup/cleanup to enable parallel test runs

## Key Implementation Details

- **Runtime**: Bun (required for bun:sqlite in webhook queue)
- **Git branches**: `feature/{task-key-lowercase}` naming convention
- **Claude execution**: Spawns subprocess with `-p --dangerously-skip-permissions`
- **JIRA integration**: Posts summaries in Atlassian Document Format
- **Webhook isolation**: Sequential queue + branch-scoped worktrees at `/tmp/devintern-review-worktree-<branch>/`
  - One worktree per PR branch (reused across reviews of the same branch; other branches pruned to bound disk usage)
  - Branch scoping is also a safety property: the base path `/tmp/devintern-review-worktree` is what project test suites target, so a PR whose own tests call `prepareReviewWorktree` (e.g. devintern reviewing its own PRs) can never delete the worktree the review is running in
  - Automatically cleans up stale worktree registrations from old paths (e.g., `.devintern-code/review-worktree/`)
- **Dependency installation**: Auto-detects package managers (bun/pnpm/npm/poetry/etc.) when preparing worktrees
