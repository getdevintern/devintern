---
title: "Relay (Instant Events)"
description: "Connect the worker to the DevIntern relay for instant PR and task events without webhook setup"
section: "Server Automation"
order: 3
sidebarHidden: true
dateModified: 2026-09-03
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
  "repoId": 987654321,
  "installationId": 12345678,
  "ref": { "pr": 142 },
  "deliveryId": "gh-delivery-uuid",
  "ts": "2026-07-03T10:00:00Z"
}
```

Explicitly excluded: diffs, file contents, ticket bodies, comment text, and credentials of any kind. When your worker receives an envelope, it fetches the real data directly from GitHub or your tracker using your own local credentials, and everything executes on your machine as usual.

If the relay is unreachable, nothing breaks: the worker's regular polling keeps running as a fallback, so relay downtime affects latency only, never correctness.

## How authentication works

Connect is an interactive step. The default `devintern worker init` flow offers sign-in, registers GitHub plus the active tracker, and stores the workspace's durable pairing under `~/.devintern/`. The relay verifies the session and your automation entitlement, then mints a durable **relay token** (`drt_…`). The worker uses that token for `/v1/status` and `/v1/events` long-polls, so polling survives session rotation, logouts, and password changes.

GitHub repository registration is completed through the DevIntern AI GitHub App. The CLI prints a short-lived installation URL and waits while GitHub authorizes the App. The relay verifies that the signed-in GitHub user can access the requested repository through that installation before it records anything. Routing then uses GitHub's immutable installation and repository IDs—not the user-supplied `owner/name` slug. An installation already associated with another DevIntern account cannot be claimed or overwritten.

The App's private key never reaches the worker: it fetches referenced PRs/comments and performs GitHub writes with its local `GITHUB_TOKEN`, so customer-owned `GITHUB_APP_ID` credentials are ignored in this relay-backed mode.

GitHub connections created before verified pairing was introduced must run `devintern worker connect github` once again. The command verifies every unpaired GitHub repository listed in the fleet workspace. Old local confirmation markers are not treated as completed setup, while an existing live relay route remains usable during the upgrade.

`LICENSE_KEY` is still required for the local unattended license gate when you run `devintern worker` (same as polling mode without the relay). It is not the credential the relay data plane accepts.

Tracker webhooks never hit your machine. Self-register commands call the tracker API from your laptop with your own API keys, pointing the callback at a private per-customer ingest URL on the relay.

### Signing in over SSH or mosh

Browser OAuth redirects to `http://127.0.0.1:<port>/auth/callback` on the machine where the CLI is running. Over SSH/mosh there is no local GUI, and opening the URL on your laptop hits your laptop's loopback — not the remote process.

**Preferred (works with mosh):** sign in on a machine with a browser, then copy the session file:

```bash
# on your laptop
devintern login
scp .devintern-code/.auth-session.json user@host:/path/to/project/.devintern-code/
```

Then re-run `worker init` / `worker connect` on the remote host (it will see you as signed in).

**SSH tunnel alternative:** remote login binds a stable callback port (`17865`, or `DEVINTERN_AUTH_CALLBACK_PORT`). From your laptop:

```bash
ssh -N -L 17865:127.0.0.1:17865 user@host
# open the printed OAuth URL in your laptop browser
```

Mosh cannot forward TCP — use `ssh` for the tunnel, or the session-copy path above.

## Quick Start

```bash
# Sign in (interactive connect step)
devintern login

# Automation license for the worker daemon
# Set LICENSE_KEY in the workspace .env (from https://devintern.com/account)

# Pair the workspace repositories for central App delivery
devintern worker connect

# Open each printed GitHub App URL and authorize the requested repository.
# The command waits for every verification, then you can run the worker:
devintern worker
```

The worker detects the workspace pairing and starts the relay connection automatically alongside its normal polling. Both `worker init` and `worker connect` store relay state under the workspace home.

For Linear, Asana, Trello, or Azure DevOps, set that tracker's credentials in the workspace `.env` or a team's `env_file` / inline `[teams.env]`, then run the matching connect command below. Jira needs no extra Jira env for registration: connect prints a private ingest URL for one-time admin webhook setup.

## Commands

| Command                                 | Description                                                               |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `devintern worker connect`              | Verify every unpaired GitHub repository in the workspace                  |
| `devintern worker connect linear`       | Self-register a Linear webhook for Issue events                           |
| `devintern worker connect asana`        | Self-register an Asana webhook for task events                            |
| `devintern worker connect trello`       | Self-register a Trello webhook for card events                            |
| `devintern worker connect azure-devops` | Self-register work item service hooks                                     |
| `devintern worker connect jira`         | Print the one-time Jira admin webhook setup with your private ingest URL  |
| `devintern worker connect status`       | Show relay status and workspace repositories still awaiting verification |

In a multi-team workspace, `devintern worker connect linear --team growth` selects that team's credential layers. If exactly one team uses the requested tracker, `--team` is optional and the CLI selects it automatically. The flag is invalid for GitHub and status because those targets are workspace-wide.

Current tracker envelopes identify their tracker type but not an individual team registration. When more than one team uses the same tracker type—for example, two separate Jira sites—`worker connect jira` refuses registration and those teams continue using their isolated polling loops. The worker also ignores an ambiguous same-tracker task envelope rather than assigning it to the first matching team. GitHub repository events and teams using distinct tracker types are unaffected.

Linear deliveries are verified with a signing secret generated on your machine. Asana deliveries are verified with the hook secret from Asana's registration handshake. Trello, Azure DevOps, and Jira deliveries carry no usable signature, so their authentication is the unguessable ingest URL itself: keep it secret, and re-run connect to rotate it.

`worker connect` stores the shared pairing under the workspace home. It skips repositories whose immutable GitHub repository IDs are already verified and continues through the remaining repositories if one pairing fails. Tracker connect uses the selected team's credential layers when applicable; otherwise it reads the workspace `.env` with explicit shell variables taking precedence.

## Environment variables

### Always

| Variable            | Required | Description                                                                                          |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| (signed-in session) | Connect  | Run `devintern login` before `worker connect`. Session lives in `.devintern-code/.auth-session.json` |
| `LICENSE_KEY`       | Worker   | Automation license for unattended `devintern worker` runs (local license gate)                       |
| `WORKER_RELAY_URL`  | No       | Relay base URL override (default: `https://relay.devintern.com`)                                     |

### Per `worker connect` target

These are the same credentials you already use for that tracker. Set them in the workspace `.env`, or use `--team <name>` to compose that team's `env_file` and inline env. GitHub connect uses every unpaired GitHub repository in `workspace.toml`. Jira connect mints the ingest URL and prints admin setup steps without calling the Jira API.

| Target         | Required env vars                                               | Notes                                                           |
| -------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| `github`       | (none beyond login + `LICENSE_KEY` for the worker)              | Repositories come from `workspace.toml`                         |
| `linear`       | `LINEAR_API_KEY`                                                | Creates the Linear webhook pointing at your relay ingest URL    |
| `asana`        | `ASANA_API_TOKEN`, `ASANA_DEFAULT_PROJECT_GID`                  | Webhook scoped to that project; Asana handshakes with the relay |
| `trello`       | `TRELLO_API_KEY`, `TRELLO_API_TOKEN`, `TRELLO_DEFAULT_BOARD_ID` | Webhook scoped to that board                                    |
| `azure-devops` | `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_PROJECT`  | Creates work item create/update service hooks                   |
| `jira`         | (none for registration)                                         | Paste the printed ingest URL into Jira admin webhooks           |

Running the worker against those trackers still needs the usual `TASK_TRACKER=…` credentials so the agent can fetch ticket bodies locally after an envelope arrives. Markdown tasks are local files and need no relay.

## How events are handled

- Reviews submitted on the agent's own PRs are addressed automatically, same as polling mode.
- New PR comments are checked for a `@devintern-ai` mention; the same permission gate applies (only users with push access can direct the agent).
- Tracker task events re-run your configured `[defaults].task_query` before acting, so "ready" still means whatever your query says.
- Every envelope is deduplicated against the worker's local database, so relay delivery and fallback polling never double-run work.

## Availability

The relay requires an automation license (solo supporter, team subscription, or legacy server addon). All sources are supported: GitHub (via the DevIntern Relay App), Linear, Asana, Trello, and Azure DevOps self-register with your own credentials, and Jira uses a one-time admin webhook setup. Markdown tasks are local files and need no relay. Every tracker also keeps working with plain polling if you prefer no DevIntern infrastructure at all.
