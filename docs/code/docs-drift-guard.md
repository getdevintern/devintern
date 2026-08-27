---
title: "Docs Drift Guard"
description: "Built-in scheduled automation that keeps documentation aligned with merged behavior"
section: "Server Automation"
order: 3
dateModified: 2026-08-27
---

# Docs Drift Guard

`docs-drift-guard` is the first built-in automation preset for the worker's [recurring automations](./worker.md#recurring-automations). After new commits merge into your repository's default branch, it compares the behavior those commits changed against the repository's documentation set and publishes what it finds either as tracker tickets or as a documentation-only pull request.

No custom prompt is needed — the preset carries its own analysis instructions, output validation, checkpointing, deduplication, and publishing logic. You configure what to guard, how often, and where the output goes.

## Enabling the preset

Presets live in the same `[[automations]]` tables as regular prompt automations. Name the preset instead of writing a prompt:

```toml
[[automations]]
id = "docs-drift"
enabled = true
repo = "web-app"              # required when the workspace has multiple repositories
preset = "docs-drift-guard"
output_mode = "ticket"        # or "pull_request"
cron = "0 5 * * *"            # same schedule options as any automation
```

| Key | Values | Meaning |
| --- | ------ | ------- |
| `preset` | `docs-drift-guard` | Selects the preset. Mutually exclusive with `prompt`. |
| `output_mode` | `ticket` (default), `pull_request` | Where findings are published. |
| `doc_paths` | array of repo-relative globs | Overrides the documentation set. |
| `baseline_sha` | commit SHA (7–40 hex chars) | Explicit first-run starting point. |

Unknown presets, unsupported output modes, invalid path patterns, and malformed SHAs are rejected at startup with actionable errors; the worker refuses entries it cannot parse and tells you the known preset names and supported modes.

## What it analyzes

The preset guards the documentation set:

- everything under `docs/` (`docs/**/*.md`),
- `AGENTS.md` and `CLAUDE.md` at the repository root and in nested directories,
- `README*` files.

Set `doc_paths` to analyze a different set instead — for example `["guides/**/*.md", "handbook.md"]`. Patterns are repo-relative globs (`*` stays within a path segment, `**` crosses directories). Absolute paths, `..` segments, and backslashes are rejected.

Each run:

1. Resolves the repository's current default branch (the same detection the CLI uses everywhere else) and updates it from the remote.
2. Reads the checkpoint: the last commit the automation processed successfully.
3. Determines what changed since the checkpoint and filters deterministically:
   - documentation paths (above) are tracked as analysis targets, not drift evidence,
   - git-ignored files are skipped entirely,
   - deleted, binary, renamed, and very large files are handled with bounded context — truncation is recorded in the run diagnostics instead of silently producing a clean result.
4. If nothing behavior-changing remains (documentation-only merges, ignored churn), the run finishes without invoking the agent and advances the checkpoint.
5. Otherwise the agent compares the merged behavior against the documentation and must answer with a validated JSON result: `no_drift`, `findings`, or `inconclusive`.

Commit messages, diffs, and file contents are treated as untrusted data: the preset's prompts instruct the agent to ignore instructions embedded in repository content and restrict it to documentation analysis or documentation-only edits.

## Checkpoints and retries

The automation stores one checkpoint per repository and automation id in the workspace database. Each run examines only `checkpoint..head`; the checkpoint advances **only after a clean outcome**:

- a validated `no_drift` result,
- a range with no behavior-changing commits,
- or successful publication of every finding (all tickets created, or the pull request pushed and opened/updated).

Anything else fails the run and leaves the checkpoint untouched, so the next scheduled occurrence retries the same commit range: unparsable agent output, `inconclusive` results, tracker or push failures, and aborted runs all retry later. Inconclusive analysis is never treated as "documentation is current".

Two safety rules around the range:

- **First run:** with no checkpoint and no `baseline_sha`, the preset records the current head as the baseline and analyzes nothing — enabling the preset never back-audits your history. Set `baseline_sha` to start from an explicit commit instead (it must be an ancestor of the default branch).
- **Rewritten history:** if the checkpoint is no longer an ancestor of the default branch (force-push, rebase), the run fails with instructions to set an explicit `baseline_sha` rather than comparing an incorrect range. Shallow clones are rejected the same way — clone with `--filter=blob:none` instead of `--depth`.

## Ticket mode

`output_mode = "ticket"` requires a tracker that can create issues. Issue creation is supported on **GitHub Issues** and **GitLab**; other trackers fail the prerequisite check before any agent work with a pointer to `pull_request` mode.

Every finding becomes one ticket containing:

- the behavior change and the required documentation update,
- supporting evidence (commits and files),
- the affected documents,
- the evaluated commit range and preset version for provenance.

Findings target the same documents with the same behavior — a deterministic dedupe key, not an agent-chosen id — so equivalent findings are deduplicated across runs: before creating a ticket, the automation searches your tracker for an open ticket carrying the finding's marker and skips creation when one exists. The scheduler's per-automation lease also prevents concurrent runs of the same automation, so duplicate publication cannot happen across overlapping occurrences.

## Pull-request mode

`output_mode = "pull_request"` requires a GitHub remote and GitHub credentials (`GITHUB_TOKEN` or the GitHub App). For each drift range the automation:

1. Creates a documentation-only branch `docs-drift/<automation-id>-<short-sha>` at the default branch head (the worktree is restored to its original branch afterwards).
2. Runs the agent with instructions to edit only files in the documentation set — if the agent produces no documentation changes, the run fails instead of opening an empty PR.
3. Commits only the documentation edits, pushes, and opens a pull request against the resolved default branch with a summary of the drift and the evaluated range.

If an open drift-guard pull request for the same automation already exists, it is reused: the branch is reset onto the new head, regenerated, force-pushed, and the PR body refreshed — one PR per automation instead of duplicates. As in ticket mode, the checkpoint advances only after the pull request exists.

## Observability

Each occurrence is recorded in the run history (origin `scheduled`, automation id, repository) with the preset version, evaluated SHA range, outcome, finding summaries, created ticket or PR references, and any truncation that occurred. No credentials or source content are stored. Filter by origin `scheduled` in the [dashboard](./dashboard.md) to see preset runs next to your other automations.

## Configuration examples

Ticket mode with a nightly audit:

```toml
[[automations]]
id = "docs-drift-nightly"
enabled = true
repo = "web-app"
preset = "docs-drift-guard"
output_mode = "ticket"
cron = "0 5 * * *"
```

Pull-request mode on a docs-heavy monorepo package:

```toml
[[automations]]
id = "sdk-docs-drift"
enabled = true
repo = "sdk"
preset = "docs-drift-guard"
output_mode = "pull_request"
interval = "1d"
doc_paths = ["packages/sdk/docs/**/*.md", "packages/sdk/README.md"]
```

Re-baselining after a history rewrite:

```toml
[[automations]]
id = "docs-drift"
preset = "docs-drift-guard"
output_mode = "pull_request"
cron = "0 */6 * * *"
baseline_sha = "abc1234"   # restart the audit window at this commit
```
