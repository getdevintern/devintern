---
title: "Relay (Instant Events)"
sidebarLabel: "Relay & Connections"
description: "Use when the worker should receive PR and tracker events in seconds through the DevIntern relay instead of polling or self-hosted webhooks."
section: "Automation"
order: 5
dateModified: 2026-11-26
---

# Relay (Instant Events)

`devintern worker connect` pairs your worker with the DevIntern relay. Webhooks from GitHub, GitLab, Linear, Asana, Trello, Azure DevOps, and Jira reach DevIntern's ingest, are reduced to reference envelopes, and your worker picks them up within seconds instead of waiting for the next poll. You need no public endpoint and no tunnel.

If the relay is unreachable, the worker's regular [polling](./worker.md#polling-mode) keeps running, so an outage affects latency only. Every envelope is deduplicated, so relay delivery and polling never run the same work twice.

## Quick start

```bash
devintern worker login github   # sign in for the worker workspace (or google, x, email you@company.com)
devintern worker connect   # pair every GitHub and GitLab repository in the workspace
devintern worker           # starts the relay connection alongside polling
```

`devintern worker init` offers the same pairing during setup. Authorize any GitHub App URL the CLI prints. GitLab hooks are created and tested automatically when the token has Maintainer or Owner access. Run `worker connect` again after adding repositories, or to repair or rotate a registration.

If you gave the DevIntern AI App access to **All repositories**, GitHub repositories you add to `workspace.toml` later, including newly created ones, are verified automatically when the worker starts or reloads its config, and `devintern worker connect github` finishes without opening the browser. A repository under a different GitHub account or organization still needs one more `devintern worker connect github` to authorize the App there.

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
| `devintern worker connect <target> --takeover` | Move registrations another worker on your account serves to this worker. See [Multiple workers](#multiple-workers-on-one-account) |

## Pairing GitHub without a terminal

`devintern worker connect github` prints the GitHub App install URL and waits up to 10 minutes for you to approve it. A coding agent or SSH session that cannot wait splits this in two, after signing in with `devintern worker login <method> --no-wait` (see [Signing in without a terminal](./worker.md#signing-in-without-a-terminal)):

```bash
devintern worker connect github --no-wait --json   # prints the install URL and exits 0
# open the URL in any browser and approve the App, then:
devintern worker connect github --status --json    # finishes local registration when approved
```

| Flag        | What it does                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `--json`    | Print one JSON document on stdout; progress text goes to stderr. Works for every target            |
| `--no-wait` | Start the pairing, print the install URL, and exit. Repositories under an existing installation are verified without a browser |
| `--status`  | Check the pending pairing once (alias `--resume`). Also finishes a pairing whose wait was interrupted |

With several GitHub accounts, each needs its own approval: run `--no-wait`, approve, `--status`, then repeat until nothing is left.

`--json` prints `{"schema": "devintern.worker-connect", "version": 1, "target", "result", ...}`. `result` is `connected` (exit 0), `pending` (exit 0: `pairing` has `id`, `state`, `installUrl`, `expiresAt`, and, when the relay provides them, `authorizeUrl` and `appInstalled`; `nextSteps` lists the URL to open (the `authorizeUrl` when the App is already installed) and the `--status` command), `action_required` (exit 2: nobody is signed in, `nextSteps` holds the `devintern worker login <method> --no-wait --json` command), or `failure` (exit 1: `error` and often a `code` such as `pairing_expired`, `no_pending_pairing`, `relay_unauthorized`, `relay_unavailable`, or `registration_owned_by_other_worker`). With a current relay every document also has `workerId`, this worker's relay identity. A `registration_owned_by_other_worker` failure lists `conflicts` (`kind`, `key`, optional `team`, `ownerWorkerId`, `ownerLabel`, and `lastSeenAt` as an ISO timestamp) and a `takeover` next step. `devintern worker connect` with no target returns one document with a `targets` array. Treat an unknown `result` as not finished.

## Environment variables

| Variable              | Required | Description                                                                    |
| --------------------- | -------- | ------------------------------------------------------------------------------ |
| (signed-in session)   | Connect  | Run `devintern worker login` first; stored in `~/.devintern/state/code/.auth-session.json` |
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

Pairing state and this worker's relay identity are stored in owner-only `~/.devintern/state/code/relay.json`.

## How events are handled

- Reviews on the agent's own PRs are addressed automatically, as in polling mode.
- PR comments that mention `@devintern-ai` are acted on only for users with push access.
- Tracker events re-run your configured ready-tasks query before acting, so "ready" still means what your query says.
- GitLab events are hints: the worker re-fetches MR, discussion, and CI state before acting.

## Multiple workers on one account

Each worker workspace has its own relay identity, created the first time it runs `devintern worker connect` or starts with a current CLI. Its label is the hostname plus a short hash of the workspace path, for example `build-01:ws-3f9a1c2e`. `devintern worker status` and the `worker doctor` Relay row show it.

A repository, GitLab project, or tracker registration (per team) belongs to one worker, and the relay delivers its events only to that worker, so two workers never both act on the same review or `@mention`. Events for registrations nobody owns go to every worker of the account, as before.

| Situation | What happens |
| --------- | ------------ |
| A second worker connects a repository another worker serves | `worker connect` fails with `registration_owned_by_other_worker`, naming the other worker's label and when it last polled |
| You want this worker to serve it instead | Run the same command with `--takeover`, for example `devintern worker connect github --takeover`. New events go to this worker; events already delivered to the old one stay there |
| The owning worker has not polled the relay for 7 days | Its registrations are free: another worker claims them without `--takeover`, and until then their events go to every worker |
| A worker connects or starts for the first time | It starts at the relay's current position and does not replay events buffered before it existed |

To move a workspace to a new host, stop the old worker, then run `devintern worker connect --takeover` on the new one.

### Upgrading from an older CLI

Workers on CLIs without relay identities keep receiving the account-wide event stream. Once any worker on the account has an identity, they receive only events no other worker owns, and their log shows a hint to upgrade. Upgrade every worker, then start each one (or run `devintern worker connect`): it claims the repositories and trackers its workspace connected, and `worker doctor` warns about any that another worker already serves.

## Signing in over SSH or mosh

Browser sign-in redirects to `127.0.0.1` on the machine running the CLI. On a remote host or in a container, run `devintern worker login github` (or `google`, `x`, `email you@company.com`) and open the printed URL in your laptop browser. After you sign in, the browser lands on a `127.0.0.1` page that does not load. Copy that page's full address, paste it into the waiting terminal, and press Enter. This works over SSH, mosh, and `docker run -it`. An email sign-in link works the same way.

With no terminal at all (a coding agent, a script, `docker exec` without `-it`), split it in two: `devintern worker login github --no-wait` prints the URL and exits, and `devintern worker login --complete '<address>'` on the same host finishes it. See [Signing in without a terminal](./worker.md#signing-in-without-a-terminal).

Over SSH you can instead forward the callback port before opening the URL (mosh cannot forward ports):

```bash
ssh -N -L 17865:127.0.0.1:17865 user@host
```

You can also copy `~/.devintern/state/code/.auth-session.json` from a machine where you are already signed in.

## Troubleshooting

`devintern worker doctor` has a **Relay** row: `polling only` when you have not paired, the number of paired repositories, relay URL, this worker's label, and what it owns when you have, and a warning when a pairing is still pending, a workspace repository is not covered, or another worker serves one of this workspace's registrations. It reads local state as of the last connect or worker start, so it also works with `--offline`.

| Symptom | Fix |
| ------- | --- |
| App already installed: `--status` stays on "Waiting for the GitHub App authorization" and GitHub showed the App's settings page instead of an install | The App is already installed on that account but not linked to your DevIntern account yet, and saving its settings does not finish pairing. With a current relay, `connect` prints an authorize URL ("The DevIntern App is already installed on ..."): open it and approve once, and the pairing completes. The install URL is then only for changing which repositories the App can access. On an older relay, run `devintern worker connect github` again: it verifies repositories under an installation already linked to your account without a browser, and a repository not covered must be added to the installation's repository access first |
| `--status` fails with "session expired or invalid" (`relay_unauthorized`) | Sign in again with `devintern worker login <method> --no-wait`, then re-run `--status`. The pending pairing is kept |
| `--status` fails with "relay unavailable" (`relay_unavailable`) | The relay returned a server error or rate limit. Retry in a few minutes; polling keeps working meanwhile |
| `connect` fails with `registration_owned_by_other_worker`, or doctor says a repository "is served by worker ..." | Another worker on your account owns it. Stop that worker or leave it be, or run the connect command again with `--takeover` to move it here. See [Multiple workers](#multiple-workers-on-one-account) |
| Worker log: "Another worker on this account uses per-worker relay routing" | This worker's CLI predates relay identities. Upgrade it and restart the worker |

## Availability

The relay requires an automation license (Supporter, Team, or Business, or a legacy server add-on). Every integration also works with plain polling if you prefer no DevIntern infrastructure.
