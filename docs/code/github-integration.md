---
title: "GitHub Webhooks and PR Automation"
description: "Advanced: deploy a repo-local GitHub webhook listener (`devintern webhook serve`)"
section: "Automation"
order: 4
sidebarHidden: true
dateModified: 2026-11-26
---

# GitHub Webhooks and PR Automation

Most installs should use the [worker](./worker.md) with the [relay](./relay.md) for PR review feedback: polling is always on, the central DevIntern AI App delivers events in seconds, and only `GITHUB_TOKEN` is needed locally. To create that token (fine-grained with Contents, Pull requests, and Issues set to Read and write and Metadata Read, or classic with `repo`), see [Token permissions](./configuration.md#github-authentication).

This page covers the advanced path: `devintern webhook serve` with a customer-owned GitHub App, for air-gapped or self-hosted installs that run their own public webhook endpoint.

## What triggers a run

The listener acts only when the App's bot is **`@`-mentioned**:

| You do this                              | GitHub event                                | Notes                                                     |
| ---------------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| Submit a review with **Request changes** | `pull_request_review` (`changes_requested`) | Inline comments are addressed together in one batch       |
| Submit a review with **Comment**         | `pull_request_review` (`commented`)         | Same batch flow                                           |
| Leave a **top-level PR comment**         | `issue_comment`                             | e.g. `@bot finish implementing this PR`                   |

Individual `pull_request_review_comment` events, approvals, and dismissals do not start runs.

On a merged or closed PR, a mention in a review body or top-level comment starts no run; the bot replies once on the PR instead.

## Prerequisites

- A **customer-owned GitHub App** (`GITHUB_APP_ID` + private key). It supplies the bot identity used for `@mention` matching and `slug[bot]` commits. See [Advanced: customer-owned GitHub App](./configuration.md#advanced-customer-owned-github-app).
- A **webhook secret** you generate yourself (`openssl rand -hex 32`). Put the same value in the App's webhook **Secret** field and in `WEBHOOK_SECRET`.
- An **automation license** (Supporter, Team, or Business) in `LICENSE_KEY`. The listener runs unattended, so it fails the license check without one.
- Your coding agent CLI installed, and Git credentials that can push to the target repositories.

## Update App permissions

In the App's **Permissions & events** settings, add these on top of the [standard App permissions](./configuration.md#advanced-customer-owned-github-app):

- Repository permissions: **Pull request review comments** (read and write), **Issue comments** (read and write), **Actions** (read, for failing job logs), **Commit statuses** (read, for non-Actions CI)
- Subscribe to events: **Pull request review**, **Pull request review comment**, **Issue comment**

Then under **Webhooks**, set the URL to `https://<your-host>/webhooks/github`, the secret to `WEBHOOK_SECRET`, and the content type to `application/json`.

## Configure and run the server

| Variable                                                          | Default                     | Description                                                       |
| ----------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `WEBHOOK_SECRET`                                                  | (required)                  | Shared secret used to verify `X-Hub-Signature-256`                |
| `LICENSE_KEY`                                                     | (required)                  | Automation license key from [devintern.com/account](https://devintern.com/account) |
| `GITHUB_APP_ID`                                                   | —                           | App ID; required for mention-gated triggers and bot commits       |
| `GITHUB_APP_PRIVATE_KEY_PATH` or `GITHUB_APP_PRIVATE_KEY_BASE64`  | —                           | App private key                                                   |
| `GITHUB_TOKEN`                                                    | —                           | Fallback when no App is configured (no mention matching). [Permissions](./configuration.md#github-authentication) |
| `WEBHOOK_PORT` / `WEBHOOK_HOST`                                   | `3000` / `0.0.0.0`          | Listen address (`--port` / `--host` override)                     |
| `WEBHOOK_AUTO_REVIEW`                                             | `false`                     | Run the self-review loop after addressing feedback                |
| `AUTO_REVIEW_ITERATIONS`                                          | `2`                         | Max review-fix cycles for the self-review loop                    |
| `WEBHOOK_MAX_RETRIES`                                             | `3`                         | Retries per failed webhook job                                    |
| `WEBHOOK_VALIDATE_IP`                                             | `false`                     | Reject requests outside GitHub's published hook IP ranges         |
| `WEBHOOK_QUEUE_DB`                                                | `~/.devintern/state/queue.db` | Persistent job queue path                                         |
| `WEBHOOK_DEBUG`                                                   | `false`                     | Verbose request and processing logs                               |

Unlike the CLI, the server is App-first: when App credentials are present they are used even if `GITHUB_TOKEN` is also set.

```bash
devintern webhook serve --port 3000
```

Run it separately from the workspace worker. Agent processes started during a review (dev servers, watchers) are stopped when each job finishes.

### Run as a systemd service

```ini
# ~/.config/systemd/user/devintern-webhooks.service
[Unit]
Description=DevIntern webhook server
After=network.target

[Service]
WorkingDirectory=/path/to/your/project
# devintern runs on bun; pin PATH so it resolves (check: dirname "$(which bun)")
Environment=PATH=/home/you/.bun/bin:/usr/local/bin:/usr/bin
EnvironmentFile=/home/you/.devintern/env/<repo>.env
ExecStart=/home/you/.bun/bin/devintern webhook serve --port 3000
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Enable it with `systemctl --user enable --now devintern-webhooks` and run `loginctl enable-linger "$USER"` so it survives logout. For a system-wide unit, place it in `/etc/systemd/system/`, add `User=`, and use `WantedBy=multi-user.target`.

## Expose the endpoint

GitHub requires HTTPS. Never expose port 3000 directly in production. Pick one:

- **Cloudflare Tunnel (recommended):** outbound-only, no open ports.
- **Tailscale Funnel:** if you already use Tailscale, `tailscale funnel 3000` gives you `https://<machine>.<tailnet>.ts.net`. See [Tailscale Funnel docs](https://tailscale.com/kb/1223/tailscale-funnel/).
- **Reverse proxy (Caddy or nginx):** on a host with a public IP, terminate TLS and `proxy_pass` / `reverse_proxy` to `localhost:3000`. Add rate limiting (about 30 requests per minute per IP) and optionally restrict to GitHub's hook IPs (`curl -s https://api.github.com/meta | jq '.hooks'`).
- **ngrok:** for short-lived testing only.

Cloudflare Tunnel example:

```bash
cloudflared tunnel login
cloudflared tunnel create devintern-webhooks
cloudflared tunnel route dns devintern-webhooks webhooks.yourdomain.com   # add --overwrite-dns if the record exists
```

```yaml
# ~/.cloudflared/config.yml
tunnel: YOUR_TUNNEL_ID
credentials-file: /path/to/.cloudflared/YOUR_TUNNEL_ID.json
ingress:
  - hostname: webhooks.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

```bash
cloudflared tunnel run devintern-webhooks   # or: sudo cloudflared service install
```

The webhook URL is then `https://webhooks.yourdomain.com/webhooks/github`.

## Security checklist

- [ ] `WEBHOOK_SECRET` is set and matches the App (unsigned or mis-signed requests are always rejected)
- [ ] The endpoint is HTTPS-only, through a tunnel or reverse proxy
- [ ] Rate limiting is configured at the proxy
- [ ] Optional: GitHub IP allowlisting (`WEBHOOK_VALIDATE_IP=true` or at the proxy/firewall)
- [ ] The server runs as a non-root user
- [ ] Logs are collected and `/health` is monitored

## Troubleshooting

Check logs with `journalctl --user -u devintern-webhooks -f`, the health endpoint with `curl https://<your-host>/health`, and **Recent Deliveries** in the App's **Advanced** settings (use **Redeliver** to retest). Run with `WEBHOOK_DEBUG=true` for verbose output.

| Issue                      | Fix                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| 401 Unauthorized           | `WEBHOOK_SECRET` does not match the App's webhook secret                                               |
| 403 Forbidden              | The sender is outside the IP allowlist, if enabled                                                     |
| 500 Internal Error         | Check the server logs for the stack trace                                                              |
| Timeout                    | Make sure the agent CLI is installed and works for the service user                                    |
| No webhook received        | Check the App's webhook URL and subscribed events                                                      |
| Mentions are ignored       | Configure `GITHUB_APP_ID` and a private key; a token alone cannot identify the bot                     |
| 530 from the public URL    | The tunnel's DNS record is missing or points at an old tunnel; re-run `route dns --overwrite-dns`      |
| `Tunnel not found` in logs | The tunnel was deleted or belongs to another account; recreate it with `cloudflared tunnel create`     |
| `bun: command not found`   | Pin `PATH` in the service unit to include the directory that contains `bun`                            |
| License check failed       | Set `LICENSE_KEY` to a Supporter, Team, or Business automation key                                     |
