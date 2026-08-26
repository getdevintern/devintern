---
title: "Worktree Isolation"
description: "Task runs execute in a disposable git worktree so your current work is never modified or lost"
section: "Code"
order: 4
dateModified: 2026-08-26
---

# Worktree Isolation

When you run a task in a git repository, devintern executes it inside a **disposable git worktree** instead of your working directory. Your uncommitted changes, staged files, stashes, and current branch are never modified — even though the task pipeline itself runs branch creation and git cleanup steps.

```bash
cd ~/projects/my-app        # dirty working tree? doesn't matter
git status                  # e.g. modified files, staged work, mid-feature branch
devintern MYAPP-456         # runs in .devintern-code/worktrees/devintern-task-myapp-456-<pid>-<ts>
```

During the run you will see:

```
🏝️  Running isolated in worktree: /home/you/projects/my-app/.devintern-code/worktrees/devintern-task-myapp-456-4242-1756...
   Based on 'origin/main'. Your working directory stays untouched.
```

## What is protected

| State                        | Protected how                                                              |
| ---------------------------- | -------------------------------------------------------------------------- |
| Uncommitted edits            | Never touched; the task operates on a separate checkout                     |
| Staged files / index         | Untouched                                                                   |
| Current branch               | The feature branch for the task is created **in the worktree**, not yours   |
| Stashes                      | Untouched (the legacy in-place flow parks changes in a stash; isolation avoids that entirely) |
| Startup sync                 | Runs as a fetch-only update of `origin/*` instead of pulling into your branch |

## Where results go

The worktree is removed when the task finishes — successfully or not — but your results survive:

- **Commits live on the task's `feature/<task-key>` branch** in your repository. Commits are stored in the shared git object database, so deleting the worktree keeps them. Check out with:

  ```bash
  git checkout feature/myapp-456
  ```

- **Uncommitted agent work is committed before removal** (`feat: implement <task-key>` after successful runs, a `wip(devintern): ...` commit after failed/interrupted runs). If a commit is impossible (e.g. failing git hooks), the remaining diff is saved to `{output-dir}/{task-key}/worktree-changes.patch` and printed — apply it with `git apply`.

With `--no-auto-commit`, isolation respects your intent and never creates automatic commits on teardown; uncommitted worktree changes are preserved as the patch file instead.

## Lifecycle

1. **Create** — a detached worktree is added from `origin/<target>` (falls back to the local target branch, then `HEAD`), under `<repo>/.devintern-code/worktrees/<task>-<pid>-<timestamp>`.
2. **Run** — the process moves into the worktree; feature branch creation, the agent run, commits, and optional PR creation all happen there.
3. **Preserve & remove** — pending changes are committed (or patched), then the worktree is removed via `git worktree remove --force` with an `rmSync` fallback and a `prune`. Teardown is best-effort: a cleanup failure never masks the task's actual result.

Cleanup runs on every exit path:

- Normal completion and handled failures (per-task in batch mode too)
- `Ctrl+C` / `SIGTERM` — synchronous cleanup before tracker reporting
- Crashes and internal `process.exit()` calls — via a shutdown guard
- Hard kills (SIGKILL, power loss) — the next run **sweeps orphans**: worktree directories whose embedded creator pid is no longer alive (plus an age backstop) are removed automatically

Concurrent executions are safe: each run gets its own uniquely named directory, and running tasks' worktrees are never swept.

## Configuration discovery

The tool's state directory (`.devintern-code`) belongs to your repository, so each worktree gets a `.devintern-code` symlink back to it. Settings, analytics identity, and durable state (`queue.db`: webhook queue, retry bookkeeping, run records) keep resolving to the real thing. The `.devintern-code` pattern is registered in your repository's local `.git/info/exclude` (never pushed), which hides both the state directory and the worktrees from `git status` and keeps them out of `git add -A`.

## Non-git directories

Running outside a git repository is supported: devintern prints a notice and processes the task directly in the current directory (no branch creation happens anyway). Nothing is created or cleaned up.

## Opting out

| Mechanism       | Usage                                                     |
| --------------- | --------------------------------------------------------- |
| CLI flag        | `--no-worktree-isolation`                                 |
| Environment     | `DEVINTERN_NO_WORKTREE_ISOLATION=1`                       |
| Custom location | `DEVINTERN_TASK_WORKTREE_DIR=/path/for/worktrees`         |

Opting out restores the legacy in-place behavior, including its pre-branch stash/clean of your working tree — prefer keeping isolation on.

`--no-git` skips all git features entirely, so isolation is skipped with it.
