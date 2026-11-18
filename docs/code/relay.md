---
title: "Relay (Instant Events)"
sidebarLabel: "Relay & Connections"
description: "Use when the worker should receive PR and tracker events in seconds through the DevIntern relay instead of polling or self-hosted webhooks."
section: "Automation"
order: 5
dateModified: 2026-11-18
---

# Relay (Instant Events)

`devintern worker connect` pairs your worker with the DevIntern relay. Webhooks from GitHub, GitLab, Linear, Asana, Trello, Azure DevOps, and Jira reach DevIntern's ingest, are reduced to reference envelopes, and your worker picks them up within seconds instead of waiting for the next poll. You need no public endpoint and no tunnel.

If the relay is unreachable, the worker's regular [polling](./worker.md#polling-mode) keeps running, so an outage affects latency only. Every envelope is deduplicated, so relay delivery and polling never run the same work twice.

## Quick start

```bash
devintern login            # interactive sign-in
devintern worker connect   # pair every GitHub and GitLab repository in the workspace
devintern worker           # starts the relay connection alongside polling
```

`devintern worker init` offers the same pairing during setup. Authorize any GitHub App URL the CLI prints. GitLab hooks are created and tested automatically when the token has Maintainer or Owner access. Run `worker connect` again after adding repositories, or to repair or rotate a registration.

For trackers, set the tracker credentials (see the table below), then run `devintern worker connect <tracker>`.

## Commands

| Command                                        | Description                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `devintern worker connect`                     | Connect every GitHub and GitLab repository in the workspace              |
| `devintern worker connect github`              | Verify every unpaired GitHub repository through the DevIntern AI App      |
| `devintern worker connect gitlab`              | Install or rotate managed hooks for all configured GitLab projects        |
| `devintern worker connect gitlab --disconnect` | Delete remembered GitLab hooks and routes; keep polling                   |
| `devintern worker connect linear`              | Register a Linear webhook for issue events                                |
| `devintern worker connect asana`               | Register an Asana webhook for task events                                 |
| `devintern worker connect trello`              | Register a Trello webhook for card events                                 |
| `devintern worker connect azure-devops`        | Register work item service hooks                                          |
| `devintern worker connect jira`                | Print your private ingest URL and the one-time Jira admin webhook steps   |
| `devintern worker connect sentry`              | Add a Sentry auto-fix project (polled directly; not sent through the relay). See [Sentry Auto-fixes](./sentry-integration.md) |
| `devintern worker connect status`              | Show relay status and repositories still awaiting verification            |

## Environment variables

| Variable              | Required | Description                                                                    |
| --------------------- | -------- | ------------------------------------------------------------------------------ |
| (signed-in session)   | Connect  | Run `devintern login` first; stored in `.devintern-code/.auth-session.json`    |
| `LICENSE_KEY`         | Worker   | Automation license for unattended `devintern worker` runs                      |
| `WORKER_RELAY_URL`    | No       | Relay base URL (default `https://relay.devintern.com`)                         |
| `DEVINTERN_AUTH_CALLBACK_PORT` | No | Fixed OAuth callback port for remote sign-in (default `17865`)              |

Each target uses the credentials you already set for that tracker or code host. They are listed on its integration page.

| Target         | Required env vars                                               | Notes                                                    |
| -------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| `github`       | none beyond sign-in                                             | Repositories come from `workspace.toml`                  |
| `gitlab`       | `GITLAB_WEBHOOK_ADMIN_TOKEN` or a usable code-host token        | Maintainer/Owner; GitLab.com and Self-Managed            |
| `linear`       | `LINEAR_API_KEY`                                                | Creates the Linear webhook                               |
| `asana`        | `ASANA_API_TOKEN`, `ASANA_DEFAULT_PROJECT_GID`                  | Webhook scoped to that project                           |
| `trello`       | `TRELLO_API_KEY`, `TRELLO_API_TOKEN`, `TRELLO_DEFAULT_BOARD_ID` | Webhook scoped to that board                             |
| `azure-devops` | `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_PROJECT`  | Work item create/update service hooks                    |
| `jira`         | none                                                            | Paste the printed ingest URL into Jira admin webhooks    |

The worker still needs the normal tracker credentials to fetch ticket bodies after an envelope arrives. Markdown tasks are local files and need no relay.

### Multi-team workspaces

`devintern worker connect linear --team growth` uses that team's credential layers (`env_file`, inline `[teams.env]`) and registers a separate, stable ingest URL for the team. `--team` is optional when exactly one team uses the tracker, and required when several do. It is not accepted for `github`, `gitlab`, or `status`. A shared `.env` may namespace credentials as `<TRACKER>_<TEAM>_<SETTING>`, for example `JIRA_PLATFORM_API_TOKEN` for team `platform`. Team-scoped registration needs an up-to-date relay; older relays return an actionable error.

## What the relay sees

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

The relay never receives diffs, file contents, ticket bodies, comment text, CI logs, agent prompts or output, or credentials. When an envelope arrives, the worker fetches the real data with your local credentials and runs everything on your machine.

- **GitHub** uses the central DevIntern AI App. Its private key never reaches the worker; the worker reads and writes with its local `GITHUB_TOKEN`, so customer-owned App credentials are ignored in this mode. Connections created before verified pairing need `devintern worker connect github` once more.
- **GitLab** hooks are created with your local token, which stays on your machine. Self-Managed instances need only outbound HTTPS to `relay.devintern.com`.
- **Linear** and **Asana** deliveries are signature-verified. **Trello**, **Azure DevOps**, and **Jira** deliveries are authenticated by the unguessable ingest URL, so keep it secret.

Pairing state is stored in owner-only `.devintern-code/relay.json` under the workspace home.

## How events are handled

- Reviews on the agent's own PRs are addressed automatically, as in polling mode.
- PR comments that mention `@devintern-ai` are acted on only for users with push access.
- Tracker events re-run your configured ready-tasks query before acting, so "ready" still means what your query says.
- GitLab events are hints: the worker re-fetches MR, discussion, and CI state before acting.

## Signing in over SSH or mosh

Browser sign-in redirects to `127.0.0.1` on the machine running the CLI. On a remote host, either copy the session file from a machine with a browser:

```bash
devintern login   # on your laptop
scp .devintern-code/.auth-session.json user@host:/path/to/project/.devintern-code/
```

or forward the callback port over SSH (mosh cannot forward ports) and open the printed URL locally:

```bash
ssh -N -L 17865:127.0.0.1:17865 user@host
```

## Availability

The relay requires an automation license (Supporter, Team, or Business, or a legacy server add-on). Every integration also works with plain polling if you prefer no DevIntern infrastructure.
