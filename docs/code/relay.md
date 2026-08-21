---
title: "Relay (Instant Events)"
description: "Connect the worker to the DevIntern relay for instant PR and task events without webhook setup"
section: "Server Automation"
order: 3
dateModified: 2026-08-22
---

# Relay (Instant Events)

`devintern worker connect` pairs your worker with the DevIntern relay. Source webhooks (GitHub, Linear, Asana, Trello, Azure DevOps, Jira) reach DevIntern's ingest, are stripped down to reference envelopes, and your worker picks them up within seconds instead of waiting for the next poll. No public endpoint on your side, no tunnels.

## What the relay sees (and what it never sees)

An envelope is a reference, not a payload:

```json
{
  "source": "github",
  "eventType": "pr.review_submitted",
  "repo": "acme/webapp",
  "ref": { "pr": 142 },
  "deliveryId": "gh-delivery-uuid",
  "ts": "2026-07-03T10:00:00Z"
}
```

Explicitly excluded: diffs, file contents, ticket bodies, comment text, and credentials of any kind. When your worker receives an envelope, it fetches the real data directly from GitHub or your tracker using your own local credentials, and everything executes on your machine as usual.

If the relay is unreachable, nothing breaks: the worker's regular polling keeps running as a fallback, so relay downtime affects latency only, never correctness.

## How authentication works

Connect is an interactive step. You sign in with `devintern login` (Supabase session on disk). The relay verifies that session and your automation entitlement, then mints a durable **relay token** (`drt_…`). The worker uses that token for `/v1/status` and `/v1/events` long-polls, so polling survives session rotation, logouts, and password changes.

`LICENSE_KEY` is still required for the local unattended license gate when you run `devintern worker` (same as polling mode without the relay). It is not the credential the relay data plane accepts.

Tracker webhooks never hit your machine. Self-register commands call the tracker API from your laptop with your own API keys, pointing the callback at a private per-customer ingest URL on the relay.

## Quick Start

```bash
# Sign in (interactive connect step)
devintern login

# Automation license for the worker daemon
# Set LICENSE_KEY in .devintern-code/.env (from https://devintern.com/account)

# Pair this repo for GitHub App delivery
devintern worker connect

# Then install the DevIntern AI GitHub App on the repository when prompted,
# and run the worker as usual:
devintern worker --query "status=todo"
```

The worker detects the pairing (stored in `.devintern-code/relay.json`, including the minted relay token) and starts the relay connection automatically alongside its normal polling.

For Linear, Asana, Trello, or Azure DevOps, set that tracker's credentials in `.devintern-code/.env` first (same vars as `TASK_TRACKER=…`), then run the matching connect command below. Jira needs no extra Jira env for registration: connect prints a private ingest URL for one-time admin webhook setup.

## Commands

| Command                                             | Description                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `devintern worker connect`                          | Register this repository for relay delivery (auto-detects the GitHub repo) |
| `devintern worker connect github --repo owner/name` | Register a specific repository                                             |
| `devintern worker connect linear`                   | Self-register a Linear webhook for Issue events                            |
| `devintern worker connect asana`                    | Self-register an Asana webhook for task events                             |
| `devintern worker connect trello`                   | Self-register a Trello webhook for card events                             |
| `devintern worker connect azure-devops`             | Self-register work item service hooks                                      |
| `devintern worker connect jira`                     | Print the one-time Jira admin webhook setup with your private ingest URL   |
| `devintern worker connect status`                   | Show registrations, buffered events, and per-source freshness              |

Linear deliveries are verified with a signing secret generated on your machine. Asana deliveries are verified with the hook secret from Asana's registration handshake. Trello, Azure DevOps, and Jira deliveries carry no usable signature, so their authentication is the unguessable ingest URL itself: keep it secret, and re-run connect to rotate it.

## Workspaces (fleet)

Multi-repo workspaces skip per-repo connect entirely. One workspace-scoped pairing lives in `~/.devintern/relay.json` — outside every checkout — and registers all fleet sources at once:

```bash
devintern login
devintern workspace connect              # pair the fleet; register every GitHub [[repos]] remote
devintern workspace connect linear       # register a tracker source (asana, trello, azure-devops, jira too)
devintern workspace connect status       # fleet-wide registrations and buffer freshness
```

- `connect` (github by default) registers every `workspace.toml` `[[repos]]` entry with a resolvable `owner/name` slug; non-GitHub remotes are skipped with a note.
- Tracker targets read their credentials from the shared workspace `.env`, so what you register is exactly what the fleet worker runs with.
- Re-running connect is idempotent; an existing relay token is never silently replaced — pass `--force` to re-mint it.
- The fleet worker loads `~/.devintern/relay.json` automatically, so no repository needs its own `.devintern-code/relay.json`. A legacy per-checkout state file still works as a fallback.

`LICENSE_KEY` keeps its usual role for unattended workers: a local license gate only. It is not a relay credential in any mode.

## Environment variables

### Always

| Variable            | Required | Description                                                                                          |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| (signed-in session) | Connect  | Run `devintern login` before `worker connect`. Session lives in `.devintern-code/.auth-session.json` |
| `LICENSE_KEY`       | Worker   | Automation license for unattended `devintern worker` runs (local license gate)                       |
| `WORKER_RELAY_URL`  | No       | Relay base URL override (default: `https://relay.devintern.com`)                                     |

### Per `worker connect` target

These are the same credentials you already use for that tracker. Set them in `.devintern-code/.env` before running the matching connect command. GitHub connect only needs a detectable git remote (or `--repo`); Jira connect mints the ingest URL and prints admin setup steps (no Jira API call from the CLI).

| Target         | Required env vars                                               | Notes                                                           |
| -------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| `github`       | (none beyond login + `LICENSE_KEY` for the worker)              | Repo from git remote, or `--repo owner/name`                    |
| `linear`       | `LINEAR_API_KEY`                                                | Creates the Linear webhook pointing at your relay ingest URL    |
| `asana`        | `ASANA_API_TOKEN`, `ASANA_DEFAULT_PROJECT_GID`                  | Webhook scoped to that project; Asana handshakes with the relay |
| `trello`       | `TRELLO_API_KEY`, `TRELLO_API_TOKEN`, `TRELLO_DEFAULT_BOARD_ID` | Webhook scoped to that board                                    |
| `azure-devops` | `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_PROJECT`  | Creates work item create/update service hooks                   |
| `jira`         | (none for registration)                                         | Paste the printed ingest URL into Jira admin webhooks           |

Running the worker against those trackers still needs the usual `TASK_TRACKER=…` credentials so the agent can fetch ticket bodies locally after an envelope arrives. Markdown tasks are local files and need no relay.

## How events are handled

- Reviews submitted on the agent's own PRs are addressed automatically, same as polling mode.
- New PR comments are checked for a `@devintern-ai` mention; the same permission gate applies (only users with push access can direct the agent).
- Tracker task events re-run your configured `--query` before acting, so "ready" still means whatever your query says.
- Every envelope is deduplicated against the worker's local database, so relay delivery and fallback polling never double-run work.

## Availability

The relay requires an automation license (solo supporter, team subscription, or legacy server addon). All sources are supported: GitHub (via the DevIntern Relay App), Linear, Asana, Trello, and Azure DevOps self-register with your own credentials, and Jira uses a one-time admin webhook setup. Markdown tasks are local files and need no relay. Every tracker also keeps working with plain polling if you prefer no DevIntern infrastructure at all.
