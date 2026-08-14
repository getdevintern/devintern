---
title: "GitHub Integration"
description: "Deploy the @devintern/code webhook server for automated PR review handling"
section: "Server Automation"
order: 4
dateModified: 2026-07-03
---

# GitHub Integration Guide

This guide covers secure deployment options for the @devintern/code webhook server to automatically address PR review comments.

## Table of Contents

- [Webhook Server Deployment Guide](#webhook-server-deployment-guide)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Prerequisites](#prerequisites)
  - [Exposure Options](#exposure-options)
    - [Option 1: Cloudflare Tunnel (Recommended)](#option-1-cloudflare-tunnel-recommended)
    - [Option 2: Tailscale Funnel](#option-2-tailscale-funnel)
    - [Option 3: Reverse Proxy (Caddy/nginx)](#option-3-reverse-proxy-caddynginx)
      - [Caddy (Automatic HTTPS)](#caddy-automatic-https)
      - [nginx](#nginx)
    - [Option 4: Direct Exposure (Not Recommended)](#option-4-direct-exposure-not-recommended)
  - [Security Layers](#security-layers)
    - [1. Webhook Signature Verification (Critical)](#1-webhook-signature-verification-critical)
    - [2. GitHub IP Allowlisting (Recommended)](#2-github-ip-allowlisting-recommended)
    - [3. Rate Limiting](#3-rate-limiting)
    - [4. Firewall Rules (OS-level)](#4-firewall-rules-os-level)
    - [5. TLS/HTTPS (Required by GitHub)](#5-tlshttps-required-by-github)
  - [GitHub App Configuration](#github-app-configuration)
    - [Update App Permissions](#update-app-permissions)
    - [Configure Webhook](#configure-webhook)
  - [Running the Server](#running-the-server)
    - [Environment Variables](#environment-variables)
    - [Start the Server](#start-the-server)
    - [Systemd Service (Linux)](#systemd-service-linux)
  - [Monitoring & Troubleshooting](#monitoring--troubleshooting)
    - [Logs](#logs)
    - [Health Check](#health-check)
    - [Test Webhook Delivery](#test-webhook-delivery)
    - [Common Issues](#common-issues)
    - [Debug Mode](#debug-mode)
  - [Security Checklist](#security-checklist)
  - [Quick Start Summary](#quick-start-summary)

## Overview

The webhook server listens for GitHub PR events and automatically runs Agent to address feedback. The architecture looks like:

```
GitHub → [Exposure Layer] → Webhook Server → Agent Harness → Git Push
```

**Key Security Principle**: The webhook server should never be directly exposed to the internet. Always use one of the secure exposure options below.

### What triggers a run

The server acts on these events, and in every case it only proceeds when the bot is **`@`-mentioned** (so it never fires on unrelated comments):

| You do this                              | GitHub event                                | Notes                                                                                   |
| ---------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| Submit a review with **Request changes** | `pull_request_review` (`changes_requested`) | Inline diff comments are addressed in one batch                                         |
| Submit a review with **Comment**         | `pull_request_review` (`commented`)         | Same batch flow; e.g. `@bot please tweak these`                                         |
| Leave a **top-level PR comment**         | `issue_comment`                             | e.g. `@bot finish implementing this PR` — needs the **Issue comments** event subscribed |

Inline review comments are processed _as a batch_ with their parent review — the standalone `pull_request_review_comment` event is intentionally ignored to avoid acting on each line comment separately. Approvals and dismissals are never actionable.

## Prerequisites

1. **GitHub App** configured with webhook permissions
2. **Webhook Secret** - a random string for request verification
3. **Agent Harness CLI** installed and configured
4. **Git credentials** with push access to target repositories
5. **Server-automation license** — the webhook server is unattended automation, so it requires a server-automation addon

> **License required.** Like scheduled runs, the webhook listener runs unattended and fails the license check without an automation license (Supporter, Team, or Business). Set `LICENSE_KEY` in your `.devintern-code/.env` (or as an `Environment=` entry in the service) to a key from [devintern.com/account](https://devintern.com/account).

Generate a webhook secret:

```bash
openssl rand -hex 32
```

You generate this secret yourself — it is **not** issued by GitHub. Put the **same** value in two places: the GitHub App's webhook **Secret** field and `WEBHOOK_SECRET` in your environment. GitHub HMAC-signs each delivery with it, and the server verifies the signature.

## Exposure Options

### Option 1: Cloudflare Tunnel (Recommended)

**Zero open ports** - Cloudflare Tunnel creates an outbound-only connection from your server to Cloudflare's edge network.

**Pros:**

- No inbound ports to open on your firewall
- Free tier available
- DDoS protection included
- Automatic HTTPS
- Works behind NAT/firewalls

**Setup:**

1. Install cloudflared:

```bash
# macOS
brew install cloudflared

# Linux
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

# Or download from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
```

2. Authenticate:

```bash
cloudflared tunnel login
```

3. Create a tunnel:

```bash
cloudflared tunnel create devintern-webhooks
```

4. Configure DNS (creates webhooks.yourdomain.com):

```bash
cloudflared tunnel route dns devintern-webhooks webhooks.yourdomain.com
```

If a DNS record for that hostname already exists (e.g. left over from a previous tunnel), this fails with `code: 1003 … record with that host already exists`. Repoint it at the new tunnel with `--overwrite-dns`:

```bash
cloudflared tunnel route dns --overwrite-dns devintern-webhooks webhooks.yourdomain.com
```

5. Create config file (`~/.cloudflared/config.yml`):

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /path/to/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: webhooks.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

6. Run the tunnel:

```bash
# Foreground
cloudflared tunnel run devintern-webhooks

# Or as a service
sudo cloudflared service install
sudo systemctl start cloudflared
```

**Final architecture:**

```
GitHub → Cloudflare Edge → Cloudflare Tunnel → localhost:3000
                                                    ↓
                                          Webhook Server (no open ports)
```

---

### Option 2: Tailscale Funnel

If you already use Tailscale for your network, Funnel provides a simple way to expose services.

**Pros:**

- Simple one-command setup
- Integrates with existing Tailscale network
- Automatic HTTPS with valid certificates

**Setup:**

1. Enable Funnel in Tailscale admin console (requires admin access)

2. Start the funnel:

```bash
tailscale funnel 3000
```

3. Your webhook URL will be: `https://your-machine-name.tailnet-name.ts.net`

**Note:** Tailscale Funnel has some limitations on free plans. Check [Tailscale Funnel docs](https://tailscale.com/kb/1223/tailscale-funnel/).

---

### Option 3: Reverse Proxy (Caddy/nginx)

Use when you have a server with a public IP and want full control.

#### Caddy (Automatic HTTPS)

1. Install Caddy:

```bash
# Debian/Ubuntu
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# macOS
brew install caddy
```

2. Configure (`/etc/caddy/Caddyfile`):

```caddyfile
webhooks.yourdomain.com {
    reverse_proxy localhost:3000

    # Rate limiting
    rate_limit {
        zone webhooks {
            key {remote_host}
            events 30
            window 1m
        }
    }

    # Optional: IP allowlisting for GitHub
    # See "GitHub IP Ranges" section below for current IPs
    @blocked not remote_ip 140.82.112.0/20 143.55.64.0/20 185.199.108.0/22 192.30.252.0/22
    respond @blocked 403
}
```

3. Start Caddy:

```bash
sudo systemctl enable caddy
sudo systemctl start caddy
```

#### nginx

1. Configure (`/etc/nginx/sites-available/webhooks`):

```nginx
server {
    listen 443 ssl http2;
    server_name webhooks.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/webhooks.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/webhooks.yourdomain.com/privkey.pem;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=webhooks:10m rate=30r/m;

    location / {
        limit_req zone=webhooks burst=5;

        # Optional: GitHub IP allowlisting
        # allow 140.82.112.0/20;
        # allow 143.55.64.0/20;
        # allow 185.199.108.0/22;
        # allow 192.30.252.0/22;
        # deny all;

        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

2. Get SSL certificate:

```bash
sudo certbot certonly --nginx -d webhooks.yourdomain.com
```

3. Enable and start:

```bash
sudo ln -s /etc/nginx/sites-available/webhooks /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

### Option 4: Direct Exposure (Not Recommended)

**⚠️ Only use this for testing with tools like ngrok**

```bash
# ngrok (temporary testing only)
ngrok http 3000
```

Never expose the webhook server directly to the internet in production.

---

## Security Layers

Regardless of which exposure method you choose, **always implement these security measures**:

### 1. Webhook Signature Verification (Critical)

This is implemented in devintern and **cannot be bypassed**. GitHub signs every webhook with your secret:

```bash
# Set your webhook secret
export WEBHOOK_SECRET="your-random-secret-here"
```

The server will reject any request without a valid `X-Hub-Signature-256` header.

### 2. GitHub IP Allowlisting (Recommended)

GitHub publishes their webhook IP ranges at `https://api.github.com/meta`. Current ranges (may change):

```
140.82.112.0/20
143.55.64.0/20
185.199.108.0/22
192.30.252.0/22
```

**Dynamically fetch current IPs:**

```bash
curl -s https://api.github.com/meta | jq '.hooks'
```

### 3. Rate Limiting

Prevent abuse even from valid sources. Recommended limits:

- 30 requests per minute per IP
- Burst of 5 requests

### 4. Firewall Rules (OS-level)

If using direct exposure or reverse proxy, add firewall rules:

```bash
# UFW (Ubuntu)
sudo ufw allow from 140.82.112.0/20 to any port 3000
sudo ufw allow from 143.55.64.0/20 to any port 3000
sudo ufw allow from 185.199.108.0/22 to any port 3000
sudo ufw allow from 192.30.252.0/22 to any port 3000

# iptables
iptables -A INPUT -p tcp --dport 3000 -s 140.82.112.0/20 -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -s 143.55.64.0/20 -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -j DROP
```

### 5. TLS/HTTPS (Required by GitHub)

GitHub requires HTTPS for production webhooks. All exposure options above provide automatic HTTPS except direct exposure.

---

## GitHub App Configuration

### Update App Permissions

Add these permissions to your GitHub App:

1. Go to your GitHub App settings
2. Navigate to **Permissions & events**
3. Under **Repository permissions**, add:
   - **Pull request review comments**: Read and write
   - **Issue comments**: Read and write (for top-level PR comments)
4. Under **Subscribe to events**, enable:
   - Pull request review
   - Pull request review comment
   - Issue comment (lets a user trigger devintern with a top-level PR comment)

### Configure Webhook

1. In your GitHub App settings, go to **Webhooks**
2. Set **Webhook URL** to your server's URL (e.g., `https://webhooks.yourdomain.com/webhooks/github`)
3. Set **Secret** to your `WEBHOOK_SECRET`
4. Select content type: `application/json`
5. Enable events:
   - Pull request reviews
   - Pull request review comments

---

## Running the Server

### Environment Variables

```bash
# Required
export WEBHOOK_SECRET="your-webhook-secret"
export LICENSE_KEY="your-server-automation-key"

# GitHub authentication.
# GitHub App auth is preferred — it resolves the bot identity (slug[bot]),
# which is REQUIRED for @mention matching and bot-attributed commits:
export GITHUB_APP_ID="123456"
export GITHUB_APP_PRIVATE_KEY_PATH="/path/to/key.pem"
# OR
export GITHUB_APP_PRIVATE_KEY_BASE64="..."

# A personal access token works as a fallback when no App is configured:
export GITHUB_TOKEN="ghp_..."

# Optional
export WEBHOOK_PORT="3000"        # Default: 3000
export WEBHOOK_HOST="0.0.0.0"     # Default: 0.0.0.0
export WEBHOOK_AUTO_REPLY="true"  # Reply to addressed comments
export WEBHOOK_AUTO_REVIEW="true" # Run self-review loop after addressing feedback
export WEBHOOK_AUTO_REVIEW_MAX_ITERATIONS="5"  # Max review iterations (default: 5)
export WEBHOOK_MAX_RETRIES="3"    # Retries per failed webhook job
export WEBHOOK_VALIDATE_IP="true" # Reject requests outside GitHub's published IP ranges
export WEBHOOK_QUEUE_DB=".devintern-code/queue.db"  # Persistent job queue path (default: .devintern-code/queue.db in the project directory)
export WEBHOOK_DEBUG="true"       # Verbose request/processing logging
```

> **Auth precedence (serve mode):** unlike the CLI — where `GITHUB_TOKEN` takes precedence — the webhook server is **App-first**. When GitHub App credentials are present they are used even if a `GITHUB_TOKEN` is also set, because the App resolves the bot identity needed for `@mention` matching and bot-attributed commits. A token alone still works (the App falls back to it when no App is configured), but mention-gated triggers and `slug[bot]` commit attribution require the App.

### Start the Server

`devintern worker --listen` runs the webhook listener inside the worker daemon. The previous `devintern serve` command still works as a deprecated alias.

```bash
# Development
bun run src/webhook-server.ts

# Production (after build)
devintern worker --listen --port 3000

# With PM2 (process manager)
pm2 start "devintern worker --listen" --name devintern-webhooks
```

### Systemd Service (Linux)

Create `/etc/systemd/system/devintern-webhooks.service`:

```ini
[Unit]
Description=@devintern/code Webhook Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/your/projects
# devintern is a `#!/usr/bin/env bun` script — pin PATH so `bun` resolves
# under systemd's minimal environment (check: dirname "$(which bun)").
Environment=PATH=/home/your-user/.local/bin:/home/your-user/.local/share/mise/installs/bun/1.3.2/bin:/usr/local/bin:/usr/bin
Environment=LICENSE_KEY=your-server-automation-key
Environment=WEBHOOK_SECRET=your-secret
Environment=GITHUB_TOKEN=ghp_...
Environment=WEBHOOK_AUTO_REPLY=true
Environment=WEBHOOK_AUTO_REVIEW=true
ExecStart=/usr/local/bin/devintern worker --listen --port 3000
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable devintern-webhooks
sudo systemctl start devintern-webhooks
```

Rather than putting secrets in the unit file, you can load them from your project's `.env` with `EnvironmentFile=/path/to/.devintern-code/.env` and drop the individual `Environment=` secret lines.

**User service (no root):** to run under `systemctl --user` instead, place the unit in `~/.config/systemd/user/`, remove the `User=` line, set `WantedBy=default.target`, manage it with `systemctl --user enable --now devintern-webhooks`, and run `loginctl enable-linger "$USER"` so it survives logout. Pair it with a user-level `cloudflared` unit the same way.

**Process cleanup.** While addressing a review, the agent may start long-running processes (dev servers, watchers) to verify its changes. Because the webhook server is always on, those would otherwise accumulate over its lifetime. @devintern/code runs each agent in its own process group and tears that group down as soon as the task finishes, so nothing is left running between reviews. On Linux, the unit's cgroup (default `KillMode=control-group`) also reaps everything when the service stops or restarts, including processes that fully daemonize.

---

## Monitoring & Troubleshooting

### Logs

```bash
# Systemd
journalctl -u devintern-webhooks -f

# PM2
pm2 logs devintern-webhooks
```

### Health Check

The server exposes a health endpoint:

```bash
curl https://webhooks.yourdomain.com/health
# {"status": "ok", "timestamp": "..."}
```

### Test Webhook Delivery

1. Go to your GitHub App settings → **Advanced**
2. View **Recent Deliveries**
3. Check response codes and bodies
4. Use **Redeliver** to test

### Common Issues

| Issue                      | Solution                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 401 Unauthorized           | Check `WEBHOOK_SECRET` matches GitHub App config                                                                    |
| 403 Forbidden              | Check IP allowlisting if enabled                                                                                    |
| 500 Internal Error         | Check server logs for stack trace                                                                                   |
| Timeout                    | Ensure Agent Harness CLI is installed and working                                                                   |
| No webhook received        | Check GitHub App webhook URL and events                                                                             |
| 530 from the public URL    | Tunnel up but DNS not routing — the CNAME is missing or points at an old tunnel; re-run `route dns --overwrite-dns` |
| `Tunnel not found` in logs | Tunnel was deleted or credentials belong to another account; recreate with `cloudflared tunnel create`              |
| License check failed       | Set `LICENSE_KEY` to a server-automation addon key                                                                  |

### Debug Mode

Run with verbose logging:

```bash
WEBHOOK_DEBUG=true devintern worker --listen
```

---

## Security Checklist

Before going to production:

- [ ] Webhook secret is set and matches GitHub App
- [ ] HTTPS is enabled (automatic with recommended options)
- [ ] Rate limiting is configured
- [ ] IP allowlisting is enabled (optional but recommended)
- [ ] Server runs as non-root user
- [ ] Logs are being collected
- [ ] Health monitoring is set up
- [ ] Firewall rules are configured (if applicable)

---

## Quick Start Summary

**Fastest secure setup (Cloudflare Tunnel):**

```bash
# 1. Install cloudflared
brew install cloudflared  # or appropriate package manager

# 2. Create tunnel
cloudflared tunnel login
cloudflared tunnel create devintern-webhooks
cloudflared tunnel route dns devintern-webhooks webhooks.yourdomain.com
#   (add --overwrite-dns if a record for that host already exists)

# 3. Set environment
export WEBHOOK_SECRET=$(openssl rand -hex 32)
export LICENSE_KEY="your-server-automation-key"
export GITHUB_TOKEN="ghp_..."   # or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH

# 4. Start server
devintern worker --listen &

# 5. Start tunnel
cloudflared tunnel run devintern-webhooks

# 6. Put the SAME WEBHOOK_SECRET in the GitHub App, and set its webhook URL to:
#    https://webhooks.yourdomain.com/webhooks/github
```

Your webhook server is now securely exposed with zero open ports!
