---
title: "Automation Packs"
sidebarLabel: "Automation Packs"
description: "Install ready-made recurring automations for your repositories, such as dependency security, CI fixes, flaky tests, and docs drift, with 'devintern automations add'."
section: "Automation"
order: 2.15
dateModified: 2026-11-24
---

# Automation Packs

An automation pack is a ready-made [recurring automation](./automations.md) for a common maintenance chore. Packs ship with `@getdevintern/code` and work on any repository: each prompt finds your package manager, CI, and documented checks itself, reads your contributor docs (AGENTS.md, CLAUDE.md, CONTRIBUTING.md) for constraints, and skips work that an open pull request already covers.

```bash
devintern automations list
devintern automations show dependency-security
devintern automations add dependency-security --repo web-app
```

`add` appends one `[[automations]]` entry to `workspace.toml`. A running worker picks it up without a restart.

## Bundled packs

All packs open a pull request, and a run that finds nothing to do succeeds without one.

| Pack | Default schedule | What it does |
| --- | --- | --- |
| `ci-red-fixer` | daily 07:00 | When CI on the default branch is failing, fixes or reverts the cause. Reports infrastructure failures instead of changing code. |
| `dependency-security` | Mondays 08:00 | Applies every in-range vulnerability fix, plus at most one breaking upgrade for a high or critical advisory. |
| `dependency-freshness` | first Monday of the month, 08:00 | Upgrades up to five groups of direct dependencies within their major version. |
| `flaky-test-finder` | Saturdays 06:00 | Finds intermittent tests from the last 30 days of CI failures and stabilizes one, verified by repeated runs. |
| `slow-test-optimizer` | Sundays 09:00 | Measures test durations and speeds up one slow test without weakening it. |
| `docs-drift` | Wednesdays 07:00 | Corrects documentation that the last week of merged changes made false. Never changes code. |

Schedules use the worker host's timezone. The CI-based packs read run history through `gh` (GitHub) or `glab` (GitLab), so install and sign in to the matching CLI on the worker host.

## `add` options

| Option | Effect |
| --- | --- |
| `--repo <name>` | Target `[[repos]]` name. Required when the workspace has more than one worker repository; `manual_only` repos can't be targets. |
| `--id <id>` | Install under another automation id, for example to run the same pack on two repositories. |
| `--disabled` | Write `enabled = false` so the entry is validated but not scheduled. |
| `--workspace <path>` | Path to `workspace.toml`. Default `~/.devintern/workspace.toml`, or the `DEVINTERN_WORKSPACE_DIR` home. |

## Customizing an installed pack

The installed entry is an ordinary automation, so edit it in `workspace.toml` like any other: change `cron`, tighten the prompt with project-specific commands, or add `harness`, `model`, and `effort` to [choose the agent](./automations.md#choosing-the-agent-per-schedule).

```toml
# Installed from automation pack "dependency-security" (version 1). ...
[[automations]]
id = "dependency-security"
enabled = true
cron = "0 8 * * 1"
repo = "web-app"
open_pr = true
allow_no_changes = true
prompt = """
Fix known security vulnerabilities in this repository's dependencies. ...
"""
```

Running `add` again for an unchanged entry does nothing. If the entry was edited, or a newer DevIntern release changed the pack (its version in the comment goes up), `add` refuses to overwrite it. Run `devintern automations show <pack>` to compare, then edit the entry by hand or install the new version under another `--id`.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `This workspace has multiple repositories` | Pass `--repo <name>` with one of the listed `[[repos]]` names. |
| `is manual_only` or `No repos configured for the worker` | The worker doesn't run automations on `manual_only` repos. Target a worker repo, or add one with `devintern worker add-repo` inside its checkout. |
| `already exists with different settings` | Pick another `--id`, or remove or edit the existing entry. |
| Every run fails with a `gh` or `glab` error | Install and sign in to the CLI for your code host on the worker host. |
| `devintern doctor` reports the automation catalog as broken | Reinstall `@getdevintern/code`; the bundled catalog files are missing or damaged. |
