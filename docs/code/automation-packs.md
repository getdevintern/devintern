---
title: "Automation Packs"
sidebarLabel: "Automation Packs"
description: "Install bundled, shareable automation recipes by name into workspace.toml with 'devintern automations add'."
section: "Automation"
order: 6
dateModified: 2026-10-16
---

# Automation Packs

An automation pack is a named, reviewable recipe for a recurring chore. Packs
ship with `@getdevintern/code` as a bundled catalog, so you can install a proven
prompt and schedule by name instead of writing one from scratch:

```bash
devintern automations list
devintern automations show dependency-health
devintern automations add dependency-health
```

Installing a pack writes one `[[automations]]` entry into `workspace.toml`. From
then on the occurrence runs through exactly the same path as a hand-written
automation — see [Worker Daemon → Recurring automations](./worker.md#recurring-automations)
for prompt-writing and schedule semantics.

## Commands

| Command | Effect |
| ------- | ------ |
| `devintern automations list` | List bundled packs with their schedule and whether they open a PR. Exits non-zero when the catalog is broken. |
| `devintern automations show <pack>` | Print one pack's description, schedule, and prompt. |
| `devintern automations add <pack>` | Install the pack into `workspace.toml`. |

`add` options:

- `--workspace <path>` — path to `workspace.toml` (default `~/.devintern/workspace.toml`, or the `DEVINTERN_WORKSPACE_DIR` home).
- `--repo <name>` — target `[[repos]]` name. Required when the workspace has more than one repository, and validated against the configured names.
- `--id <id>` — install under a different automation id (useful to run the same recipe twice with different schedules or repos).
- `--disabled` — write `enabled = false` so the entry is validated but not scheduled.

Installing the same pack twice is idempotent: an identical entry is left
unchanged. If the id is already taken by a different automation, `add` refuses
and asks you to pick another `--id` or edit the existing entry.

## Example

```bash
$ devintern automations add dependency-health --repo backend
✅ Installed "dependency-health" into ~/.devintern/workspace.toml
   Repo: backend
   Start or reload `devintern worker` to pick it up.
```

The resulting entry (the prompt is inlined as a single-line TOML string):

```toml
# Installed from the bundled automation pack "dependency-health".
[[automations]]
id = "dependency-health"
enabled = true
cron = "0 8 * * 1"
repo = "backend"
open_pr = true
prompt = "Review the project's declared dependencies...\nRun the project's test suite..."
```

`worker` re-validates `workspace.toml` while running, so an installed entry is
picked up without a restart.

## Bundled packs

| Id | Cadence | Opens PR | What it does |
| -- | ------- | -------- | ------------ |
| `dependency-health` | `0 8 * * 1` (weekly) | yes | Applies at most one safe, verified dependency upgrade within the current major version. |
| `flaky-test-triage` | `0 6 * * 6` (weekly) | yes | Re-runs the suite, gathers evidence, and stabilizes at most one confirmed flaky test. |
| `log-triage` | `0 5 * * *` (daily) | no | Reviews recent local logs and fixes or reports one high-confidence defect. |
| `e2e-test-expansion` | every `7d` | yes | Adds one focused end-to-end test for an uncovered user journey. |

The prompts are deliberately tool-agnostic: they tell the agent to use the
project's own test and dependency commands rather than assuming a specific
ecosystem. Tune any installed entry by editing the `[[automations]]` block
directly, or start from a pack with `--id` and adjust the schedule.

## Catalog layout and validation

The catalog is read-only and shipped with the package:

```
catalog/
  catalog.json            # index of pack ids
  packs/
    <pack-id>/
      pack.json           # name, description, schedule, open_pr, prompt file
      prompt.md           # the automation prompt
      references/         # optional supporting files
```

`pack.json` fields:

```json
{
  "id": "dependency-health",
  "name": "Dependency health",
  "description": "…",
  "schedule": { "cron": "0 8 * * 1" },
  "openPr": true,
  "prompt": "prompt.md",
  "references": ["references/notes.md"]
}
```

`devintern doctor` validates the bundled catalog and reports it as one check
(`Automation catalog`):

- **Broken entries** (missing prompt file, duplicate id, invalid schedule,
  id/directory mismatch) fail the check.
- **Orphaned entries** (a pack directory present but not listed in
  `catalog.json`, or a dangling reference) warn.

This keeps a bad packaging change from silently shipping unusable recipes.

## Packs can bundle a pipeline

A pack may ship a `pipeline` definition alongside its automation, so verifying
and customizing a recurring job stays one packaging story:

```json
{
  "id": "with-pipeline",
  "prompt": "prompt.md",
  "pipeline": {
    "plugins": ["./.devintern-code/steps/check-policy.ts"],
    "steps": [{ "use": "implement" }, { "use": "commit" }, { "use": "finalize" }]
  }
}
```

On install, the pipeline is written to `~/.devintern/pipelines/<id>.json` and
`[defaults].pipeline_file` is pointed at it — unless the workspace already
declares a default pipeline, in which case the install warns and leaves it
alone. See [Customizing the Task Pipeline](./pipelines.md) for the pipeline
schema.

## When to hand-write instead

Packs cover common chores; they are not a replacement for a prompt tuned to your
codebase. When a pack's default scope does not fit, install it and edit the
`[[automations]]` block, or write the entry by hand as described in
[Worker Daemon → Recurring automations](./worker.md#recurring-automations).
