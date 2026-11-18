---
title: "Story Points Estimation"
description: "Schedule unattended AI story-point estimation via [[estimations]] in workspace.toml, or run one-shot --estimate"
section: "Automation"
order: 6
sidebarHidden: true
dateModified: 2026-11-18
---

# Story Points Estimation

DevIntern can estimate tracker tasks with your AI agent, either as a one-shot CLI run with `--estimate` or on a schedule with the [worker](./worker.md). Use it for backlog grooming or to keep estimates current as tasks change.

For each task the agent reads the description, comments, linked resources, and related issues, then:

- picks a Fibonacci estimate (1, 2, 3, 5, 8, 13, 21),
- writes it to the tracker's story points field, and
- posts a comment with its confidence (high, medium, low), reasoning, risks, and unclear areas.

Estimation works with Jira, Linear, Azure DevOps, and Asana (via a custom field). GitHub and GitLab get a comment only. Trello and markdown are not supported.

## One-shot from the CLI

```bash
devintern PROJ-123 --estimate

# Batch: every task matching a query
devintern --estimate --query "project = PROJ AND sprint in openSprints() AND 'Story Points' is EMPTY"
```

`--jql` still works as a deprecated alias of `--query`.

## Which tasks are skipped

- Tasks created less than 24 hours ago, so the team has time to refine them.
- Tasks with an estimate comment that have not changed since. A task updated after its estimate is re-estimated, and the existing comment is updated instead of a new one being posted.

## Scheduled estimation with the worker

Add `[[estimations]]` entries to `workspace.toml`. The worker runs `devintern --estimate --query "<query>"` when each entry comes due. Estimation never implements, creates branches, or opens PRs.

```toml
[[estimations]]
id = "weekday-groom"
enabled = true
cron = "0 9 * * 1-5"
query = "status = 'To Do' AND labels IN (NeedsEstimate)"
```

| Key                          | Description                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`                         | Stable, unique name. Required.                                                                              |
| `enabled`                    | `true` or `false`. Required.                                                                                |
| `query`                      | Tracker query for the tasks to estimate. Required.                                                          |
| `cron` or `interval`         | Exactly one. Same format as [automations](./automations.md#defining-an-automation).                        |
| `team`                       | Estimate against this [team's](./workspaces.md#multiple-teams-and-tracker-boards) tracker and credentials. |
| `harness`, `model`, `effort` | Agent for this schedule. See [Choosing the agent per schedule](./automations.md#choosing-the-agent-per-schedule). |

Without `team`, an entry uses `[defaults].tracker` and the shared `.env`. With `team`, it uses that team's tracker, its credential layers, and its tracker's query language; a team's fixed `repo` is ignored. The worker refuses to start if `team` names an unknown team or one whose tracker cannot estimate. There is no `repo` key: estimation never touches a repository.

```toml
[[teams]]
name = "oss"
tracker = "github"
task_query = "label:devintern"
env_file = "teams/oss.env"   # GITHUB_TOKEN, GITHUB_REPO=acme/sdk

[[estimations]]
id = "oss-groom"
enabled = true
team = "oss"
interval = "6h"
query = "label:needs-estimate"
```

Notes:

- Without `[[estimations]]`, estimation is off. `[defaults].task_query` is never estimated on its own. `worker init` does not set up estimations.
- Entries can be added, changed, or removed while the worker runs. A sweep in progress is not interrupted.
- While estimations are configured, the worker runs one agent at a time, so sweeps do not compete with other work for usage limits.
- A usage limit ends the sweep cleanly; the next occurrence continues. Missed and overlapping occurrences follow the same rules as [automations](./automations.md#how-occurrences-run).
- A task where only the field or only the comment was written is reported as failed and retried on the next sweep.
- Each sweep appears in the [dashboard](./dashboard.md) with the `estimate` origin.

## Story points field (Jira)

DevIntern finds the field by common names such as `Story Points` and `Story Point Estimate`. If yours has another name, set it in `.devintern-code/settings.json`:

```json
{
  "projects": {
    "PROJ": {
      "storyPointsField": "customfield_10016"
    }
  }
}
```

## Troubleshooting

| Problem                                   | Fix                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Story points field not found`            | Set `storyPointsField` in `.devintern-code/settings.json`.                                |
| `Failed to parse estimation response`     | The agent returned non-JSON output. Run with `--verbose` and check that the agent CLI works. |
| Low-confidence estimates                  | The comment asks for more detail. Refine the task description; the next run re-estimates it. |
