---
name: devintern-delegate
description: Delegate agreed implementation work to a DevIntern worker as ad-hoc tasks for registered repositories. Use when asked to enqueue work, hand independent follow-ups to DevIntern, or dispatch implementation without creating tracker tickets.
---

# Delegate work to DevIntern

Use `devintern worker add` to hand work to an existing workspace worker. It runs the task through the configured implementation pipeline in a separate checkout. Creating tracker tickets with `devpm` is a different workflow.

## Check the destination

- Check `devintern worker add --help` before dispatching. This command was introduced by [PR #278](https://github.com/getdevintern/devintern/pull/278); older installations do not support it. If unavailable, report the missing capability rather than silently switching to a foreground implementation run or installing an unreleased build.
- Read the selected workspace's `[[repos]]` names and remotes. The default file is `~/.devintern/workspace.toml`; honor an explicit workspace path or `DEVINTERN_WORKSPACE_DIR` override. Match the intended repository by remote, then use its registered name for `--repo`. Do not guess from the current directory's basename. Multiple repos require an explicit destination.
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

- `--json` reserves stdout for one result object with `id`, `taskKey`, `repo`, `status`, and `deduplicated`; human diagnostics go to stderr. Check the exit code as well as the result. Validation failures may have no result object.
- Without `--wait`, success means the task was durably enqueued, not implemented. It remains queued if the daemon is stopped. Do not start a daemon implicitly just because a task is pending.
- Deduplication applies only while the matching task is pending or running. Reusing a key after settlement creates another occurrence. It is not permanent exactly-once delivery; do not blindly resubmit after an ambiguous response.
- Injected tasks bypass quiet hours. They inherit `[defaults].worker_task_args`, whose default is `--create-pr`; dispatch can therefore start work immediately and open a PR. They use the worker's automation entitlement.

Wait only when completion is needed for the caller's next step. Append `--wait --wait-timeout 600` for a bounded ten-minute wait, choosing a limit appropriate to the task. The CLI default is six hours; `0` disables the timeout. With `--wait --json`, stdout still contains one final object. Exit `0` indicates success and `1` indicates failure to complete the wait successfully.

A timeout, worker stop, or inconclusive wait can produce a `status: "failed"` result with an `error` even though the task itself has not failed or been cancelled. Inspect the error and existing run in the dashboard or worker logs before considering another enqueue. Do not edit the queue database or managed prompt files to retry or cancel work.

## Report the outcome

Return the repository, task ID/key, and whether this was a new enqueue or a deduplicated task. Say whether the task is queued, completed, failed, or its completion is unknown. Include a PR URL only when confirmed by the run artifacts or dashboard; the enqueue response itself does not provide one.

For command behavior and troubleshooting, consult the [ad-hoc task guide](https://devintern.com/docs/code/worker#ad-hoc-tasks-worker-add). When working in the DevIntern source repository, the corresponding source is `docs/code/worker.md`; check the installed CLI's help when documentation and installed capabilities differ.
