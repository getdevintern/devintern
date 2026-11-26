---
title: "Notifications: Desktop, Slack, and Webhooks"
sidebarLabel: "Notifications"
description: "Use when you want to hear about failed or escalated worker runs without keeping the dashboard open: desktop notifications, Slack, a JSON webhook, and a daily digest."
section: "Automation"
order: 4.1
dateModified: 2026-11-26
---

# Notifications: Desktop, Slack, and Webhooks

The dashboard [Inbox](dashboard.md#inbox) only helps when someone has it open. The worker can also send notifications to your desktop, a Slack channel, or any HTTP endpoint, so a DevIntern failure or an escalation that needs you reaches you right away. Routine items, such as PRs waiting on review, can be collected into one daily digest instead.

Nothing is sent until you turn on a channel. Out of the box, notifications stay in the dashboard.

## Set up

Add one table per channel to `workspace.toml`. Keep secrets such as the Slack webhook URL in the workspace `.env` (`~/.devintern/.env`), not in `workspace.toml`:

```toml
[notifications.slack]
url_env = "SLACK_WEBHOOK_URL"   # the default; set it in ~/.devintern/.env
digest_time = "09:00"           # routine items once a day instead of right away

[notifications.desktop]         # notify-send on Linux, osascript on macOS
```

```bash
# ~/.devintern/.env
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/XXXX
```

Create the URL in Slack under **Apps → Incoming Webhooks**. The worker applies changes to `workspace.toml` without a restart. A changed `.env` needs `devintern worker service restart`.

Then check and send a test message:

```bash
devintern worker doctor --test-notifications
```

The **Notification delivery** row lists each channel and whether it can send from this machine. `--test-notifications` sends one test message per channel.

## What gets sent

- A new notification, and a grouped one that happens again (for example **×3** becomes **×4**).
- At most one message per cause in each `rate_limit_minutes` window (default 1 hour). If the same error keeps happening, you get one message, then another with the latest count after the window ends.
- No message when a notification resolves on its own, unless the channel sets `notify_resolved = true`.
- When a channel is turned on, notifications from before that are not sent.

Each message has the title, the short cause, the repository, and a link to the run (or the inbox) in the dashboard. Tokens and other secrets are removed before anything leaves the machine.

By default a channel sends only **high** severity items: failures, escalations, exhausted retries, broken automations, unhealthy sources, and DevIntern errors. Set `min_severity = "normal"` to also get informational items, such as PRs opened or auto-merged.

### Daily digest

With `digest_time` set, a channel sends one summary a day at that local time: the count of items per kind and the most frequent items, with links. The digest collects normal-severity items and escalations where a review or merge rule held a PR for you. On that channel those items are no longer sent one by one, so the urgent messages stand out. A day with nothing to report sends no digest. If the channel is unavailable or the send fails at digest time, the same digest goes out once the channel works again.

## Settings

All keys are optional. A channel table that is present is turned on.

| Setting                       | Default                     | What it does                                                                              |
| ----------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| `[notifications] dashboard_url` | first `[dashboard].allowed_origins` entry, else `http://localhost:<dashboard_port>` | Address used for links in messages. Set it when you open the dashboard from another device. |
| `[notifications] timezone`    | the machine's local time    | IANA timezone for `digest_time`, for example `"Europe/Berlin"`.                           |
| `enabled`                     | `true`                      | Set `false` to turn a channel off without removing it.                                    |
| `min_severity`                | `"high"`                    | `"high"`, or `"normal"` to send every severity.                                           |
| `kinds`                       | all kinds                   | Only send these kinds, for example `["internal_error", "escalated"]`.                     |
| `exclude_kinds`               | none                        | Never send these kinds.                                                                    |
| `rate_limit_minutes`          | `60`                        | At most one message per cause in this window. `0` turns the limit off.                    |
| `notify_resolved`             | `false`                     | Also send a message when a notification this channel sent is resolved.                   |
| `digest_time`                 | off                         | Local time `"HH:MM"` for the daily digest.                                                |
| `url_env` (Slack)             | `"SLACK_WEBHOOK_URL"`       | Name of the `.env` variable that holds the incoming webhook URL.                          |
| `url` / `url_env` (webhook)   | `url_env = "DEVINTERN_NOTIFICATION_WEBHOOK_URL"` | Endpoint, inline or from a `.env` variable. Use `url_env` when the URL contains a token. |
| `secret_env` (webhook)        | none                        | `.env` variable with a signing secret. Each request then carries `X-DevIntern-Signature: sha256=<HMAC of the body>`. |

Kinds: `escalated`, `retries_exhausted`, `automation_broke`, `work_spawned`, `pr_opened`, `pr_auto_merged`, `source_unhealthy`, `internal_error`.

### Webhook payload

`[notifications.webhook]` POSTs JSON. A notification looks like this; a digest has `"type": "digest"` and a `digest` object instead:

```json
{
  "source": "devintern",
  "version": 1,
  "type": "notification",
  "event": "created",
  "notification": { "id": 42, "kind": "internal_error", "severity": "high", "count": 1, "repo": "acme/web", "title": "Likely DevIntern bug: verify failed", "body": "…", "links": [] },
  "cause": "verify: worktree vanished",
  "dashboardUrl": "http://localhost:4400/#/runs/953"
}
```

`event` is `created`, `resurfaced`, `resolved`, or `test`.

## Troubleshooting

| Problem                                         | Fix                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Doctor shows `SLACK_WEBHOOK_URL is not set`     | Add the variable to `~/.devintern/.env`, then restart the worker.                                            |
| Doctor shows `notify-send not found on PATH`    | Install `libnotify` (`notify-send`). On a headless server, use Slack or a webhook instead.                     |
| No desktop notifications from the service       | The worker must run in your desktop session to reach the notification daemon. Use Slack or a webhook on servers. |
| Test fails with `HTTP 403` or `HTTP 404`        | The webhook URL was revoked or mistyped. Create a new one and update `.env`.                                  |
| Links open `localhost` on another device        | Set `[notifications] dashboard_url`, or add the address to `[dashboard].allowed_origins` ([Access from another device](dashboard.md#access-the-dashboard-from-another-device)). |

A failed delivery is retried a few times and then logged in the worker log (`devintern worker logs`). It never affects runs or what the inbox shows.
