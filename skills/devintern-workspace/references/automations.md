# Configure recurring automations

Use `[[automations]]` in the selected `workspace.toml` for recurring prompt-based work. Each occurrence runs the normal task pipeline in the registered repository's persistent base worktree with shared workspace and repo environment layers. It does not create a tracker ticket or receive team-specific tracker credentials. An automation-only workspace can omit the task query and tracker credentials; the workspace schema still requires `[defaults].tracker` to name a supported tracker. Unattended execution needs worker automation access and a configured agent.

Read the [recurring automation guide](https://devintern.com/docs/code/worker#recurring-automations) for product behavior and the [workspace guide](https://devintern.com/docs/code/workspaces#how-workspace-automations-differ-from-single-repo-ones) for execution context. In a source checkout, use `docs/code/worker.md`, `docs/code/workspaces.md`, and `packages/code/src/lib/automation/config.ts`. Installed skills must work without that checkout.

## Translate the request into an entry

Identify the registered repository, desired outcome, cadence, output destination, and whether the result should open a PR. Infer these from the request and existing configuration where possible; ask only about choices that materially change behavior. A request to add an automation authorizes configuring that schedule, but does not by itself request an immediate trial run.

- Match the destination to an existing `[[repos]].name`. Set `repo` explicitly for clarity; it is required with multiple repositories, even for disabled entries. Repository names, not remote URLs or local checkout paths, belong in this field. Work that writes outside the repository still needs a repository execution context.
- Use a stable, unique `id`, starting with a letter or digit and containing only letters, digits, `.`, `_`, or `-`. Preserve the ID when editing an existing automation: schedule state and run history use it. Set boolean `enabled` explicitly. Use `false` when the user requests a draft or paused schedule; otherwise enable the requested recurring work.
- Set exactly one of `cron` or `interval`. Cron has five fields and uses the **worker host's timezone**, not the user's browser or chat timezone. Verify the worker host timezone before translating a wall-clock request. There is no per-automation timezone field; do not invent one or silently change the host timezone. Intervals are positive whole minutes, hours, or days such as `15m`, `6h`, or `1d`; `30s` and `1h30m` are unsupported. An interval is elapsed cadence, not a promise to run at a particular wall-clock time.
- Set `open_pr = true` when the requested repository changes should become a reviewable PR. It defaults to `false`: PR/review flags are stripped and `--no-git` is applied, so no branch, push, or PR is created. A prompt asking for a PR or inherited `--create-pr` cannot enable it. For reports or drafts written elsewhere, keep it false and specify the output destination. This setting controls git workflow, not whether the agent can edit files or call external services.

Automations bypass `[worker.schedule]` task pickup windows. Encode requested hours in the automation's cron rather than changing quiet hours or assuming they constrain recurring work. Scheduled estimation queries belong in `[[estimations]]`; one-off implementation handoffs use `worker add`, not a recurring entry.

## Write the task prompt

The inline `prompt` is the task description. Include the necessary context, one bounded unit of work per occurrence, acceptance criteria, verification commands appropriate to the repository, and when to stop or make no changes. Prefer concrete recurring maintenance over broad instructions such as "improve the codebase."

Make repeat runs useful: check whether the work or output already exists, avoid duplicate changes, and state the outcome when nothing needs doing. For external output, use a destination available on the worker host and define whether to append, replace, or create a dated file. Do not assume a local path or file from the current chat exists on a remote worker. Check existing sandbox access if the output is outside the repository; do not broaden permissions as an incidental config edit. Include only external publishing or messaging actions covered by the user's request.

Keep PR policy in `open_pr`, rather than asking the prompt to override it. Do not change shared `[defaults].worker_task_args` to tune one automation: those flags also affect polled tasks and other PR-enabled automations. Store credentials in the existing environment layers, never in the prompt.

For example, replace the repository and test command with actual values:

```toml
[[automations]]
id = "dependency-health"
enabled = true
repo = "web-app"
cron = "0 9 * * 1"
open_pr = true
prompt = """Check for outdated dependencies and upgrade at most one within its current major version.
Check whether an existing open PR already covers the upgrade; skip it if so.
Run bun test. If verification fails, revert this run's upgrade and report the failure.
Do not change unrelated dependencies or production behavior.
Done means one verified upgrade with a summary, or an explanation that no eligible upgrade remains."""
```

Use TOML multiline strings for prompts and escape their delimiters or backslashes correctly. Do not invent `prompt_file`, per-entry task flags, or other undocumented fields.

## Validate and activate

Preserve unrelated TOML and existing automation entries. Validate syntax plus the entry's fields, unique ID, registered repo, and schedule before saving to a running workspace. Disabled entries are still validated. In a source checkout, `parseWorkspaceConfig` validates the schema; also check repository selection with `resolveFleetAutomations` in `packages/code/src/lib/workspace/workspace-worker.ts`, because the parser alone does not reject a missing repo in a multi-repo automation. Neither requires starting a daemon. With only an installed CLI, inspect help for a validator; do not invent `worker validate`. Report syntax/documented-constraint validation honestly if schema validation is unavailable.

Automation edits live-reload for subsequent work. Inspect existing worker logs for a successful reload and, when available, the dashboard's Automations table for the entry, schedule, repository, and PR setting. An invalid reload leaves the last valid configuration running. If the worker is stopped, the entry is configured but will not execute until it starts; do not launch a second daemon to validate. Follow the workspace skill's restart guidance when the change also involves startup-only settings.

Adding or changing a schedule sets its next due time; saving an entry does not immediately execute it. Unchanged schedules retain their interval anchor. Disabling or removing an entry stops future scheduling but lets an active occurrence finish. Missed occurrences coalesce to at most one run after startup; overlapping or repository-busy occurrences are skipped rather than replayed. Do not promise execution at an exact minute when the worker or repository is busy.

When the user requests an immediate trial, use the dashboard's **Automations → Run now** action if available. It uses the same repository, environment, PR policy, and overlap lease as scheduled work; it performs real work and may create a PR. Do not invent an automation CLI subcommand or use `worker run-now`, which drains task pickup rather than selecting an automation. Inspect the resulting run and artifacts before reporting success.

Report the config path, automation ID, repository, enabled state, cadence with host timezone, PR policy or output destination, validation performed, and evidence of reload or the remaining activation step. Distinguish a configured schedule from a successfully executed occurrence.
