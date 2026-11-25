---
title: "Recurring Automations"
sidebarLabel: "Automations"
description: "Use when the worker should run a prompt on a schedule: [[automations]] entries, prompt writing, opt-in PRs, no-op and blocked runs, and per-schedule agents."
section: "Automation"
order: 2.1
dateModified: 2026-11-24
---

# Recurring Automations

An automation is a prompt the [worker](./worker.md) runs on a schedule. The prompt is the task: nothing is created in your tracker, so an automation-only worker needs no tracker credentials. Each occurrence goes through the normal task pipeline and is recorded in the [dashboard](./dashboard.md) with the `scheduled` origin.

To configure automations through a coding agent, use the [devintern-workspace skill](https://github.com/getdevintern/devintern/tree/main/plugins/devintern/skills/devintern-workspace). For example: "Add a weekly dependency-health automation for web-app, Mondays at 09:00, opening a PR for at most one verified upgrade."

To start from a ready-made recipe instead of writing a prompt, install a bundled [automation pack](./automation-packs.md): `devintern automations add dependency-security --repo web-app`.

## Defining an automation

Add `[[automations]]` entries to `workspace.toml`:

```toml
[[automations]]
id = "dependency-health"
enabled = true
repo = "web-app"
interval = "6h"
open_pr = true
prompt = """Pick one outdated dependency and upgrade it within the same major version.
Run the test suite; if anything breaks, revert the upgrade instead of fixing forward."""

[[automations]]
id = "weekday-tweets"
enabled = true
repo = "web-app"
cron = "0 21 * * 1-5"
prompt = """Draft one tweet about the product and save it as a markdown file
under ~/Documents/Tweets/."""
```

| Key                | Description                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `id`               | Stable, unique name. Required.                                                                    |
| `enabled`          | `true` or `false`. Required. Disabled entries are validated but not scheduled.                    |
| `prompt`           | What the agent should do. Required.                                                               |
| `cron`             | Five-field cron expression in the worker host's timezone. Set exactly one of `cron` or `interval`. |
| `interval`         | `15m`, `6h`, `1d`, and so on.                                                                     |
| `repo`             | Target repository. Required when the workspace has more than one repo.                            |
| `open_pr`          | Open a pull request for the result. Default `false`.                                              |
| `allow_no_changes` | Treat a run that changes nothing as a success. Default `false`.                                   |
| `harness`, `model`, `effort` | Agent for this schedule. See [Choosing the agent per schedule](#choosing-the-agent-per-schedule). |

A worker with at least one automation runs even without a task query. Edits to `workspace.toml` apply without a restart; an invalid entry is logged and the last valid config keeps running.

To try an entry without waiting for its schedule, use **Run now** in the [dashboard](./dashboard.md#run-an-automation-now). It runs the same pipeline with the same `open_pr` setting.

## Writing good prompts

The prompt replaces the ticket description, so write it like a task for a new teammate:

- **One change per run.** "Apply one safe improvement" gives reviewable PRs; "clean up the repository" does not.
- **State the guardrails.** What not to touch, when to stop, and what must pass ("Run the test suite before committing").
- **Say what done means.** Concrete success criteria make escalations rare.
- Prefer recurring maintenance (dependency bumps, flaky-test triage, changelog refreshes) over open-ended feature work.

## Opening a pull request is opt-in

`open_pr` decides whether an occurrence becomes a pull request. It is off by default, which suits work whose output lands outside the repository (reports, drafts). With it off, no branch is pushed and no PR is created, even if `[defaults].worker_task_args` contains `--create-pr`.

Set `open_pr = true` for code changes that should be reviewed. Those runs use `[defaults].worker_task_args` (for example `--create-pr --auto-review --auto-review-iterations 3`) and the repo's PR labels, and always create a PR. The dashboard's Automations table shows an **opens PR** badge on these entries.

**Upgrading:** PRs used to be the default. Set `open_pr = true` on any automation that should keep opening PRs.

## Allowing a no-op run

Some jobs should do nothing when there is nothing to do: "keep main green", "release only when warranted". Without `allow_no_changes = true`, a PR-opening run that makes no commit fails with `Implementation was not committed`. With it, the run is recorded as a successful no-op and no branch or PR is created.

```toml
[[automations]]
id = "main-red-fixer"
enabled = true
interval = "12h"
open_pr = true
allow_no_changes = true
prompt = """Keep main green. If the latest CI run on main succeeded,
make no changes and report that main is already green."""
```

For a one-off CLI run, the equivalent flag is `--allow-no-changes`.

## Reporting a blocked run

An agent that stops cleanly has not necessarily succeeded. Every implementation run (automations and tracker tasks) can state its outcome with one line after its final `<!-- devintern:summary:end -->` marker:

```text
<!-- devintern:outcome status=blocked reason="the unit test gate (bun run test) failed" -->
```

| `status`         | Meaning                                                                | Recorded run                         |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| `blocked`        | The goal was not met: a required gate failed, a step was refused, or a dependency was unavailable. | `escalated`, reason `blocked: …`     |
| `partial`        | Part of the goal was met; the reason says what is missing.            | `succeeded`, reason `partial: …`     |
| `noop` or `done` | Nothing to do, or the goal was met.                                    | `succeeded`                          |
| no marker        | —                                                                      | `succeeded`                          |

"Nothing to do" is not blocked: a `main-red-fixer` that finds main green should omit the marker or use `status=noop`. A gate that already fails the same way on the base commit, in a way the change did not cause, is reported as `partial` unless making that gate pass is the task's goal. The agent confirms this by re-running the gate on the base revision. The run is recorded `succeeded` with a reason starting `partial: pre-existing on base:`, so you can find and review these runs. Prompts can rely on the built-in instruction or name which failures count as blocked ("if the test gate fails, report the run as blocked").

Escalated runs appear in the dashboard, the stats escalation rate, and `devintern report --last`. The next attempt is the next occurrence, **Run now**, or a dashboard retry. For tracker tasks, a blocked outcome changes only the run record: a PR the run already opened stays open, and a markdown task is not marked `Done`. Only a whole line in the final report counts; the reason is truncated to 300 characters.

## Choosing the agent per schedule

By default every run uses the workspace `AGENT_HARNESS`, `AGENT_MODEL`, and `AGENT_EFFORT`. An `[[automations]]` or `[[estimations]]` entry can override them, so a cheap model can do daily triage while a stronger one does release work:

```toml
[[automations]]
id = "dependency-bump"
enabled = true
interval = "1d"
model = "sonnet"          # primary harness, failover still applies
prompt = "Upgrade one outdated patch-level dependency and run the tests."

[[automations]]
id = "release-manager"
enabled = true
cron = "0 9 * * 1"
harness = "codex"         # pin one agent; opts out of failover
model = "gpt-5.2"
effort = "high"
open_pr = true
prompt = "Cut the next release and update the changelog."
```

- `harness` names one registered agent. An unknown name fails validation. Pinning a harness opts the entry out of the `AGENT_HARNESS` failover chain, and the worker warns at startup if that agent's CLI is not installed.
- `model` is a harness-specific string. Without `harness`, it applies to the primary harness only, so a fallback harness runs on its own default model.
- `effort` is `low`, `medium`, or `high`. Harnesses without reasoning effort ignore it with a warning.
- Precedence: **entry field > team/repo env > workspace env > harness default.** When a pin changes the harness, inherited `AGENT_MODEL`, `AGENT_EFFORT`, and `AGENT_CLI_PATH` values meant for the primary are dropped.

Changes apply to the next occurrence; a run in progress keeps its agent.

## How occurrences run

- Missed occurrences (for example while the worker was down) collapse into at most one run after startup.
- If the previous occurrence of the same automation is still running, or another task holds the repository, the occurrence is skipped, not queued.
- When every agent harness is usage-limited, the occurrence is skipped and the schedule moves on.
- Changing an entry's schedule resets it: the next run is the next scheduled time.
- Occurrences skip the clarity (feasibility) check.

In a multi-repo workspace an occurrence runs in the repository's persistent base checkout (`~/.devintern/worktrees/<repo>/base`), reset to the default branch first, with the same environment layers as the repo's tasks: shared `.env`, then the repo's `env_file`, then `[repos.env]`. That includes the auto-filled `GITHUB_REPO` / `GITLAB_PROJECT` described in [Workspaces → Environment](./workspaces.md#environment). It takes the per-repo lock, so it never runs at the same time as a task in that repo.

Each occurrence writes its prompt to `~/.devintern/automations/<id>/<timestamp>.md`. To rerun one by hand:

```bash
devintern ~/.devintern/automations/dependency-health/2026-08-24T09-00-00-000Z.md
```

These files are only run inputs and are safe to delete.

## Troubleshooting

| Symptom                                      | Fix                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| No occurrences fire after editing the TOML   | Check the worker log for validation errors naming the entry. A changed schedule waits for its next time. |
| `occurrence skipped: previous run is active` | The previous occurrence is still running. Use a longer schedule for long prompts.                      |
| `occurrence skipped: repository is busy`     | Another task holds the repo lock. The next occurrence runs normally.                                   |
| `occurrence skipped: no agent harness is available until …` | Every harness is usage-limited. Add a fallback to `AGENT_HARNESS`.                     |
| Scheduled runs missing from the dashboard    | Filter runs by origin `scheduled`. Check the startup log for a license problem.                        |
| A PR-opening run fails with `Implementation was not committed` | Set `allow_no_changes = true` if doing nothing is a valid result.                  |

For reading worker logs and run data, see [Worker Troubleshooting](./worker-troubleshooting.md#reading-logs-and-run-data).
