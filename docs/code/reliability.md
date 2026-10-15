---
title: "Reliability: Idempotent State Mutations"
sidebarLabel: "Reliability Audit"
description: "Audit of multi-step workers that must converge when interrupted, and the guarantees that keep them idempotent"
section: "Automation"
order: 6
dateModified: 2026-10-15
---

# Reliability: Idempotent State Mutations

Unattended workers can be killed at any point. A multi-step operation that writes state in more than one step must converge on the same end state whether it ran once, was interrupted halfway, or ran again. This page records the audit of the two state mutators most exposed to interruption and the guarantees that now apply to them.

## Scope

| Path | Mutation |
| --- | --- |
| Conflict-resolver push (`lib/review/conflict-resolver.ts`) | Rebuilds a merge in a worktree and publishes it to the PR/MR branch |
| Run-recorder stage writes (`lib/state/run-recorder.ts`) | Terminalizes a run and appends the outcome stage in `.devintern-code/queue.db` |

## Findings

### Run-recorder stage writes — fixed

`RunStore.finishRun` performed two independent writes with no transaction: an `UPDATE runs ...` and an `INSERT INTO run_stages ...` for the `outcome` row. Two concrete divergences followed:

- **Split writes.** A crash between the two statements left a run marked terminal with no `outcome` stage, so the recorded history disagreed with the run status.
- **Append-only outcomes.** Calling `finishRun` again for the same run (a retry, a late child process that outlived a reap, or manual recovery) appended a second `outcome` row. The end state depended on how many times the finish ran.

`reapOrphanedRuns` had the same shape from the other direction: it terminalized abandoned `in_progress` runs but never wrote an `outcome` stage, so a reaped run and a normally finished run did not look the same downstream.

**Fix.** The row update and the outcome stage are now one SQLite transaction, and the outcome stage is replaced (`DELETE` + `INSERT`) instead of appended. `reapOrphanedRuns` writes a matching `outcome` stage for every run it reaps in the same transaction, and only targets `in_progress` rows so repeated sweeps are no-ops. A subsequent `finishRun` for a reaped run replaces the reaped outcome rather than stacking a second one.

Non-terminal stages (`feasibility`, `implementation`, `auto_review`, `change_request`) stay append-only by design: they record ordered events, and the same stage may legitimately appear more than once in one run. Only the terminal outcome must be unique.

### Conflict-resolver push — already guarded, documented

The push is the only remote mutation. Every attempt rebuilds it from a freshly fetched remote tip (the review worktree is reset to `origin/<branch>`) and pushes fast-forward-only, so an interruption at any point converges:

- **Before the merge:** the merge is recomputed from the current base.
- **After a local commit but before the push:** the local work is discarded when the worktree is rebuilt, then rebuilt deterministically.
- **After the push:** the merge is already an ancestor of the branch tip, so `attemptMerge` reports "already up to date" and returns `skipped` without re-running the agent or writing the remote again.

The guards that make this hold are the expected-head lease (`expectedHeadSha`), the ancestry check in `Utils.pushCurrentBranch`, and the non-fast-forward rejection handling — none of which overwrite a concurrent human push. This behavior is now stated explicitly in the module header and covered by a regression test.

## Tests

Interruption/re-run behavior is locked in by tests:

- `packages/code/tests/run-recorder.test.ts`
  - `finishRun is idempotent: repeated calls converge on one terminal outcome`
  - `reapOrphanedRuns records one outcome stage and repeated sweeps are no-ops`
  - `a late finishRun replaces the reaped outcome instead of appending`
- `packages/code/tests/conflict-resolver.test.ts`
  - `a re-run after the merge already landed converges without a second push`

## Verifying locally

```bash
bun run --filter @getdevintern/code test
```

## Delivery failures

A run that cannot commit its implementation (including an agent that produces no
changes), fails pre-push validation, or cannot push its branch is recorded as
failed. It does not proceed to PR/MR creation or mark the task as completed.
Agent process failures also stop delivery, even if the agent left local edits.
Batch CLI exit status alone is not a per-task success signal; inspect the recorded
run outcome and delivery output.
