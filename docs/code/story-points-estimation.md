---
title: "Story Points Estimation"
description: "Automatically estimate JIRA story points with AI using the --estimate flag"
section: "Server Automation"
order: 6
dateModified: 2026-08-26
---

# Story Points Estimation

Use the `--estimate` flag to have your AI agent analyze JIRA tasks and automatically assign story point estimates. This is useful for backlog grooming, sprint planning, or keeping estimates up to date as tasks evolve.

## What It Does

- Analyzes task description, comments, linked resources, and related issues
- Produces a **Fibonacci-scale** estimate (1, 2, 3, 5, 8, 13, 21)
- Provides **confidence level** (high / medium / low), reasoning, risks, and unclear areas
- Sets the story points field directly in JIRA
- Posts a rich estimation comment with full context

## Usage

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

## Automated Estimation

`--estimate` is still a CLI one-shot. The [worker](./worker.md) does not schedule estimation yet. Until it does, the unattended path is a systemd timer or crontab of `devintern --estimate --query`. Prefer that over inventing a second daemon; drain ready tickets with the worker, and keep this timer only for story points.

### systemd timers

A systemd job is a one-shot `.service` plus a `.timer` that triggers it. Below is the daily morning run; the weekly grooming and sprint-planning helpers follow the same shape with different `OnCalendar` expressions and JQL.

#### Daily estimation (weekday mornings)

Run every weekday at 9 AM to estimate new tasks.

`/etc/systemd/system/devintern-estimate-daily.service`:

```ini
[Unit]
Description=Daily estimation of NeedsEstimate tasks
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=devintern
WorkingDirectory=/path/to/your/project
ExecStart=/usr/local/bin/devintern --estimate \
  --query 'project = PROJ AND status = "To Do" AND labels IN (NeedsEstimate)'
StandardOutput=journal
StandardError=journal
```

`/etc/systemd/system/devintern-estimate-daily.timer`:

```ini
[Unit]
Description=Run daily estimation at 9 AM on weekdays

[Timer]
OnCalendar=Mon..Fri *-*-* 09:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable and inspect:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now devintern-estimate-daily.timer
systemctl list-timers devintern-estimate-daily.timer
journalctl -u devintern-estimate-daily.service -f
```

#### Weekly backlog grooming

`OnCalendar` for Monday at 8 AM, JQL covers the last 7 days:

```ini
# devintern-estimate-weekly.timer
[Timer]
OnCalendar=Mon *-*-* 08:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# devintern-estimate-weekly.service, ExecStart line
ExecStart=/usr/local/bin/devintern --estimate \
  --query 'project = PROJ AND status = "Backlog" AND updated >= -7d'
```

#### Sprint planning helper

Wednesday at 10 AM, fills in any remaining gaps before planning:

```ini
# devintern-estimate-sprint.timer
[Timer]
OnCalendar=Wed *-*-* 10:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# devintern-estimate-sprint.service, ExecStart line
ExecStart=/usr/local/bin/devintern --estimate \
  --query 'project = PROJ AND sprint in openSprints() AND "Story Points" is EMPTY'
```

### Cron

If you're not on systemd, the same three schedules work as crontab entries:

```bash
# In crontab (run `crontab -e`)

# Daily at 9 AM, weekdays: estimate new tasks
0 9 * * 1-5 cd /path/to/your/project && devintern --estimate --query 'project = PROJ AND status = "To Do" AND labels IN (NeedsEstimate)' >> /tmp/devintern-estimate.log 2>&1

# Weekly on Monday at 8 AM: re-estimate recently updated backlog
0 8 * * 1 cd /path/to/your/project && devintern --estimate --query 'project = PROJ AND status = "Backlog" AND updated >= -7d' >> /tmp/devintern-estimate.log 2>&1

# Weekly on Wednesday at 10 AM: sprint planning helper
0 10 * * 3 cd /path/to/your/project && devintern --estimate --query 'project = PROJ AND sprint in openSprints() AND "Story Points" is EMPTY' >> /tmp/devintern-estimate.log 2>&1
```

### Important Notes

- Set `WorkingDirectory` (systemd) or `cd` (cron) to your project directory so the correct `.devintern-code/.env` is loaded
- Use absolute paths to `devintern` and your agent binary, or pin `PATH` explicitly in the unit file
- For systemd, `journalctl -u <unit>` gives you logs; for cron, redirect stdout/stderr to a log file
- Test your JQL query manually before scheduling
- Tasks created less than 24 hours ago are automatically skipped, so frequent runs are safe

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
