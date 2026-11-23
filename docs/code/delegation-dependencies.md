---
title: "Dependent Delegated Tasks"
sidebarLabel: "Dependent Tasks"
description: "Use when one delegated task must wait for another: queue it with `devintern worker add --after`, choose merged or stacked mode, and read waiting and blocked states."
section: "Automation"
order: 1.6
dateModified: 2026-11-20
tags: ["worker", "delegation", "worker-add", "dependencies", "stacked-prs"]
---

# Dependent Delegated Tasks

Part of [Delegate Tasks to the Worker](./delegation.md).

## Dependent tasks (`--after`)

Enqueue dependent work immediately instead of waiting for the first task to
finish or merge. The worker holds the dependent task until its dependencies are
far enough along:

```bash
devintern worker add --repo backend --title 'Add the orders API' --json
# → { "taskKey": "local-add-the-orders-api", ... }
devintern worker add --repo backend --title 'Use the orders API in checkout' \
  --after local-add-the-orders-api --json
```

`--after` is repeatable. A line in the body works too, with the same markdown
flexibility as `Target branch:` (headings, bold/italic, list items, table
cells):

```markdown
**Depends on**: local-add-the-orders-api, local-add-order-events
```

`--after` keys and `Depends on:` keys are merged and de-duplicated, then stored
on the task. Only words shaped like task keys (`local-…` or `PROJ-12`) count on
a `Depends on:` line, so prose such as `Depends on: the orders API being
deployed` declares nothing. Every `--after` key must name an existing ad-hoc
task (any status); a `Depends on:` key that names no ad-hoc task (for example a
tracker ticket mentioned for context) is ignored, and `worker add` prints a
warning. Dependencies must be **in the same repo** and must not form a cycle;
otherwise the command fails with an error and enqueues nothing. Cross-repo
dependencies are not supported.

## Modes: merged and stacked

| Mode                | Starts when                                                                                                | Base and PR target                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `stacked` (default on GitHub) | every dependency's latest run succeeded (its PR may still be open)                                         | the one unmerged dependency's branch |
| `merged` (default elsewhere)  | every dependency's PR has merged (a dependency that succeeded with nothing to deliver counts as satisfied) | the default branch, as usual         |

Pick the workspace default with `[defaults].dependency_mode` in
[`workspace.toml`](./workspaces.md#the-workspace-file), and override it per task with
`--stack` or `--wait-merge` (mutually exclusive). When `dependency_mode` is not
set, tasks for GitHub repos are stacked and tasks for other repos (GitLab,
Bitbucket) wait for the merge, because the worker only maintains stacked PRs
on GitHub. The resolved mode is stored on the task.

- **merged** is the safe choice: each PR is reviewed and merged against the
  default branch, at the cost of waiting for each merge before the next task
  starts.
- **stacked** keeps work moving while reviews are pending. With exactly one
  dependency unmerged, the task branches from that dependency's branch, its PR
  targets it, and auto-review diffs against it; the PR description opens with
  "Stacked on #N". With **two or more** dependencies still unmerged, a branch
  cannot have two bases, so the task waits until at most one remains unmerged.
  With all of them merged, it behaves like merged mode.
- An explicit `Target branch:` line in the body wins over the stacked base; the
  worker logs a warning.
- A stacked PR that merges into its base's branch does not put its work on the
  default branch. Tasks that depend on it count it as merged only once its base
  has merged too. Until then, merged mode waits on the base's PR, and stacked
  mode stacks on the base's branch, which now carries both tasks' work. Once
  both have merged, the worker compares GitHub's merge times: a stacked PR
  merged into its base's branch **after** the base merged never reached the
  default branch, so dependents are blocked ("merged into feature/… after …
  merged") until that work lands and they are re-queued. A stacked PR that was
  retargeted to the default branch before merging counts as merged directly;
  on GitHub, one merged into any other branch blocks its dependents too. The
  worker learns merge times and the merged-into branch from GitHub (and asks
  GitHub while it has not yet) and from GitLab when it sees a merge request
  merge. When it cannot tell the order (Bitbucket, or GitLab without a merge
  time), dependents of a stacked PR merged into its base's branch keep waiting.

**After the base PR changes, merges, or closes** (GitHub repos), the worker
keeps the stacked PR up to date. It checks about once a minute
(`WORKER_STACKED_PRS_INTERVAL_SECONDS`, default `60`):

- **Base gets new commits** (review fixes, an amended and force-pushed base,
  or the base was itself restacked):
  the stacked branch is rebased onto the base's new head and force-pushed. A
  chain A → B → C follows along: when B moves, C is rebased onto B.
- **Base merges:** the stacked PR is retargeted to the branch the base merged
  into (normally the default branch), unless GitHub already did that, then
  rebased so only its own commits remain. After a squash merge this drops the
  base's original commits, which would otherwise show up again and conflict.
- **Base closes without merging:** the stacked PR is not retargeted. The worker
  posts one comment on it explaining why it is blocked, and tasks that depend
  on the stacked task show `blocked: <task> blocked: <base> PR #<n> closed
  without merging` in `worker queue`. Reopen (and merge) the base, and the
  worker lifts the block, updates its comment, and resumes keeping the PR up
  to date. Or re-queue the base, or retarget the PR by hand: the block lifts on
  the next pass, and the worker leaves that PR's base alone from then on. Once
  the stacked PR itself merges or closes, its dependents follow that PR.

A stacked PR with a review, CI-fix, or conflict-resolution run in progress is
rebased only after that run finishes.

If a rebase conflicts, the worker pushes nothing and leaves the PR to the
regular [conflict resolution](./pr-follow-up.md#merge-conflicts-on-the-agents-prs)
(an agent run), which picks it up once GitHub reports the PR as conflicting.
Auto-merge never merges a PR whose base is another agent PR's branch. It
considers the PR once the PR targets the default branch. **GitLab** stacked
merge requests are not retargeted or restacked yet, and **Bitbucket** is not
supported. Retarget those by hand after the base merges.

## Waiting and blocked

A dependent task stays `pending` while it waits; the worker re-checks it on
every injected-task tick from the local run and PR records. For a GitHub repo
it also asks GitHub about a dependency PR it is waiting on (closed with an
unknown reason, or still open locally) at most once every 5 minutes per PR, so
a merge is noticed even when no review poller watches that PR.
**Bitbucket:** the worker cannot see Bitbucket PRs merge yet, so merged mode
waits indefinitely there; use `--stack` (or `dependency_mode = "stacked"`) for
Bitbucket repos. Waiting tasks do not take a concurrency slot, are not counted as
deferrals, and cannot hit the deferral cap.

A task is **blocked** when a dependency's task failed, its latest run is
`failed`, `escalated`, or `abandoned`, its PR was closed without merging, or
it pushed its branch but PR creation failed (`pushed but PR creation failed`).
Blocked tasks stay pending too: re-queue the dependency
(`devintern worker add --resume <dependencyKey>`), and once it satisfies the
mode the dependent task starts.

`devintern worker queue` (and `--json`, `GET /api/queue`, and the dashboard's
Queued list) shows each dependent task's dependencies, mode, and reason, for
example `waiting: local-foo PR #12 not merged` or `blocked: local-foo escalated`.
