---
title: "Story Points Estimation"
description: "Schedule unattended AI story-point estimation via [[estimations]] in workspace.toml, or run one-shot --estimate"
section: "Server Automation"
order: 6
dateModified: 2026-08-27
---

# Story Points Estimation

Let the [workspace worker](./worker.md) estimate stories on a schedule with `[[estimations]]` in `workspace.toml`, or use the `--estimate` flag as a CLI one-shot. In both modes your AI agent analyzes tasks and automatically assigns story point estimates — useful for backlog grooming, sprint planning, or keeping estimates up to date as tasks evolve.

```toml
[[estimations]]
id = "weekday-groom"
enabled = true
cron = "0 9 * * 1-5"
query = "status = 'To Do' AND labels IN (NeedsEstimate)"
```

## What It Does

- Analyzes task description, comments, linked resources, and related issues
- Produces a **Fibonacci-scale** estimate (1, 2, 3, 5, 8, 13, 21)
- Provides **confidence level** (high / medium / low), reasoning, risks, and unclear areas
- Sets the story points field directly in JIRA
- Posts a rich estimation comment with full context

## Usage (CLI one-shot)

`--estimate` remains the interactive/one-shot path; scheduled sweeps run the same engine from the worker.

### Single Task

```bash
devintern PROJ-123 --estimate
```

### Batch via JQL

```bash
# Estimate all tasks in the backlog
devintern --estimate --query "project = PROJ AND status = 'To Do'"

# Estimate unestimated tasks in the current sprint
devintern --estimate --query "project = PROJ AND sprint in openSprints() AND 'Story Points' is EMPTY"

# Estimate recently updated tasks
devintern --estimate --query "project = PROJ AND updated >= -7d"
```

`--jql` still works as a deprecated alias of `--query`.

## Smart Behavior

### Skip Recently Created Tasks

Tasks created less than **24 hours ago** are automatically skipped. This gives the team time to refine the description before estimation.

### Smart Re-Estimation

If a task already has an estimation comment:

- If the task hasn't been updated since the last estimate → **skipped**
- If the task was updated after the last estimate → **re-estimated in place** (existing comment is updated, not duplicated)

This keeps estimates fresh without creating comment clutter.

## Story Points Scale

| Points | Meaning                                                  |
| ------ | -------------------------------------------------------- |
| **1**  | Trivial change, config tweak, typo fix                   |
| **2**  | Small, well-defined task, single file change             |
| **3**  | Moderate task, a few files, clear requirements           |
| **5**  | Significant feature, multiple files, some complexity     |
| **8**  | Large feature, cross-cutting concerns, integration work  |
| **13** | Very large, multiple subsystems, high complexity         |
| **21** | Epic-sized, major architectural change, high uncertainty |

## Configuration

### Story Points Field

The tool auto-discovers the story points field in JIRA by searching for common names like:

- `Story Points`
- `Story Point Estimate`
- `Story point estimate`

If your JIRA instance uses a custom field name, you can override it in `.devintern-code/settings.json`:

```json
{
  "projects": {
    "PROJ": {
      "storyPointsField": "customfield_10016"
    }
  }
}
```

---

## Scheduled Estimation with the Worker

The [workspace worker](./worker.md) runs unattended estimation for you via `[[estimations]]` in `workspace.toml`. No more cron of `--estimate`: the worker owns the timer, the durable schedule state, and serialization with all other agent work.

```toml
[[estimations]]
id = "weekday-groom"
enabled = true
cron = "0 9 * * 1-5"
query = "status = 'To Do' AND labels IN (NeedsEstimate)"

[[estimations]]
id = "sprint-gaps"
enabled = true
cron = "0 10 * * 3"
query = "sprint in openSprints() AND \"Story Points\" is EMPTY"
```

Each entry needs a unique `id`, boolean `enabled`, a non-empty `query`, and exactly one of `cron` or `interval`. There is no `prompt` and no `repo`: a due entry runs one-shot `devintern --estimate --query "<query>"`, which estimates — never implements, branches, or opens PRs. Estimating does not depend on `[defaults].task_query`; an omitted or empty `[[estimations]]` table simply means estimation is off.

You can add, remove, enable, disable, reschedule, or change the query of an estimation entry while the worker is running. The worker validates and reconciles the edit automatically without interrupting an in-progress sweep.

Notes:

- Works with Jira, Linear, Azure DevOps, Asana, and GitHub (comment-only). Trello/markdown workspaces fail at startup.
- Runs use the full skip/re-estimate behavior above (24h gate, update-in-place).
- Usage-limit aborts end the sweep cleanly; the next occurrence retries. Tickets already written stay done.
- Each sweep is visible in the [dashboard](./dashboard.md) under its own `estimate` origin.

See [Worker Daemon → Scheduled story-point estimation](./worker.md#scheduled-story-point-estimation) for semantics and troubleshooting.

## Example Output

```
📊 Running in estimation mode...

============================================================
📊 Estimating: PROJ-456

🔄 Re-estimating PROJ-456: task updated since last estimate
✅ Estimated PROJ-456: 5 story points (high confidence)

============================================================
📊 Estimation Summary:
   Estimated: 3
   Skipped (< 24h old): 1
   Skipped (not updated): 2
   Failed: 0
```

## Troubleshooting

**"Story points field not found"**

- Check your JIRA instance's custom field name for story points
- Set `storyPointsField` in `.devintern-code/settings.json`

**"Failed to parse estimation response"**

- The AI agent may have returned non-JSON output
- Try running with `--verbose` to see the raw response
- Check that your agent CLI is working correctly

**Low confidence estimates**

- The estimation comment will flag low confidence and ask for more details
- Consider refining the task description before re-estimating
