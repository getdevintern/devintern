---
name: devintern-delegate
description: Delegate agreed implementation work to a DevIntern worker as ad-hoc tasks for registered repositories. Use when asked to enqueue work, hand independent follow-ups to DevIntern, or dispatch implementation without creating tracker tickets.
---

# Delegate work to DevIntern

Use `devintern worker add` to hand work to an existing workspace worker. It runs the task through the configured implementation pipeline in a separate checkout. Creating tracker tickets with `devpm` is a different workflow.

## Local or remote worker

`devintern worker add` must run on the machine that runs the worker. The worker is remote when the user names an SSH host for it, or when `DEVINTERN_WORKER_SSH` is set in your environment (a skill convention; the CLI does not read it). In that case run every step below on that host: `ssh <host> '<command>'` for each `devintern` command and each workspace read, with paths such as `~/.devintern/workspace.toml` and `--workspace` resolved on the host. Do not look for a local install or local workspace in remote mode, and do not install DevIntern locally to work around a remote problem.

- Check `ssh <host> 'devintern worker add --help'` first. If `devintern` is not found over SSH, retry once with `~/.bun/bin/devintern`. If SSH itself fails (unknown host, authentication, timeout), report the blocker and point at the [remote delegation setup](https://devintern.com/docs/code/delegation#delegate-from-another-machine); do not change SSH or Tailscale configuration unasked.
- Send the brief on stdin with `--body-file -` (`ssh <host> "devintern worker add … --body-file - --json" < brief.md`) so the remote shell never parses it. Keep the title free of single quotes, or escape it for the remote shell.
- The worker uses its own checkout. Push the commits the task depends on, or copy the needed findings into the brief; local-only branches and files are invisible to it.
- A dropped SSH connection ends `--wait` locally but not the task. Prefer short bounded waits, and check `worker runs` over SSH before enqueueing again.

## Check the destination

- Check `devintern worker add --help` before dispatching. This command was introduced by [PR #278](https://github.com/getdevintern/devintern/pull/278); older installations do not support it. If unavailable, report the missing capability rather than silently switching to a foreground implementation run or installing an unreleased build.
- Read the selected workspace's `[[repos]]` names and remotes. The default file is `~/.devintern/workspace.toml`; honor an explicit workspace path or `DEVINTERN_WORKSPACE_DIR` override. Match the intended repository by remote, then use its registered name for `--repo`. Do not guess from the current directory's basename. Multiple repos require an explicit destination.
- A repo fixed to one `[[teams]]` entry (`repo = "<name>"`) runs ad-hoc tasks with that team's credentials automatically. If enqueueing fails because several teams are fixed to the repo, ask the user which team's credentials to use and pass it with `--team <name>`; do not pick one yourself.
- Enqueue only work covered by the user's request. Prefer independent tasks that can be reviewed separately. Coordinate overlapping changes or dependencies before dispatching several tasks. A worker agent should not delegate its own assigned implementation back into the worker unless explicitly asked to orchestrate further work.
- Missing workspace configuration, credentials, or automation access are setup issues. Report the specific blocker; do not change worker policy just to make enqueueing succeed.

## Prepare the handoff

Write a self-contained Markdown brief with the desired behavior, relevant files or symbols, acceptance criteria, scope boundaries, and useful verification commands. Include the necessary conversation context: the worker does not inherit this chat, uncommitted edits, or local-only files. Reference committed paths, accessible issue/PR URLs, and revisions when they matter. Include needed local findings in the brief itself; do not include credentials.

The body is limited to 20,000 characters. Prefer a file passed through `--body-file` over interpolating a long prompt into a shell command. Use a unique temporary file for each handoff and remove it after enqueueing has returned.

## Dispatch

For example, after writing the brief to `/tmp/devintern-task-UNIQUE.md`:

```bash
devintern worker add --repo backend \
  --title 'Fix checkout retry handling' \
  --body-file /tmp/devintern-task-UNIQUE.md \
  --idempotency-key checkout-retry-followup --json
```

Replace the example repo, file, title, and key with the actual task values. Add `--workspace /absolute/path/to/workspace.toml` when using a nondefault workspace. `--body-file -` reads the brief from stdin. Use a stable idempotency key for retries of the same intended dispatch, and different keys for distinct work.

- `--json` reserves stdout for one result object with `id`, `taskKey`, `repo`, `status`, and `deduplicated`; human diagnostics go to stderr. When every harness in the worker's `AGENT_HARNESS` chain is usage-limited, the object also has `harnessPausedUntil` (ISO-8601): the task is queued but cannot start before that time. Check the exit code as well as the result. Validation failures may have no result object.
- Without `--wait`, success means the task was durably enqueued, not implemented. It remains queued if the daemon is stopped. Do not start a daemon implicitly just because a task is pending.
- Deduplication applies only while the matching task is pending or running. Reusing a key after settlement creates another occurrence. It is not permanent exactly-once delivery; do not blindly resubmit after an ambiguous response.
- Injected tasks bypass quiet hours. They inherit `[defaults].worker_task_args`, whose default is `--create-pr`; dispatch can therefore start work immediately and open a PR. They use the worker's automation entitlement.

For dependent work, enqueue every step immediately: dispatch the first task, then pass its `taskKey` to the next with `--after <taskKey>` (repeatable, same repo only) instead of waiting for completion or a merge. By default on GitHub repos (stacked mode; other hosts default to `--wait-merge` behavior) the worker holds the dependent task until its dependency succeeded, then branches from it and opens a PR stacked on it; the worker retargets and rebases that PR once the base merges. With `--wait-merge` it instead waits until the dependency's PR merges. Prefer the workspace default unless the caller asked for one mode. Check `devintern worker add --help` (or `devintern worker --help`) for `--after` first: older CLIs lack it, and then you must wait for the dependency before enqueueing the next task. The `--json` result includes `dependsOn` and `dependencyMode`; `devintern worker queue --json` shows a waiting or blocked task's reason.

Wait only when completion is needed for the caller's next step. Append `--wait --wait-timeout 600` for a bounded ten-minute wait, choosing a limit appropriate to the task. The CLI default is six hours; `0` disables the timeout. With `--wait --json`, stdout still contains one final object. Exit `0` indicates success and `1` indicates failure to complete the wait successfully.

A timeout, worker stop, or inconclusive wait can produce a `status: "failed"` result with an `error` even though the task itself has not failed or been cancelled. Inspect the error and existing run before considering another enqueue: `devintern worker runs --task-key <taskKey> --json` and `devintern worker runs show <id> --json` read the run history without the dashboard (they also work inside a sandbox), and `devintern worker logs --level warn` shows recent worker output. Do not edit the queue database or managed prompt files to retry or cancel work; withdraw a task that has not started with `devintern worker cancel <taskKey>` (a `--wait` caller then exits `3` with `status: "cancelled"`).

## Report the outcome

Return the repository, task ID/key, and whether this was a new enqueue or a deduplicated task. Say whether the task is queued, completed, failed, or its completion is unknown. If the result carried `harnessPausedUntil`, say the task is queued behind a usage limit until that time. Include a PR URL only when confirmed by the run record (`prUrl` in `devintern worker runs show <id> --json`), its artifacts, or the dashboard; the enqueue response itself does not provide one.

For command behavior and troubleshooting, consult the [delegation guide](https://devintern.com/docs/code/delegation). When working in the DevIntern source repository, the corresponding source is `docs/code/delegation.md`; check the installed CLI's help when documentation and installed capabilities differ.
