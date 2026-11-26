---
name: devintern-setup
description: Install DevIntern Code, set up a self-hosted worker, or connect source control and task tracker accounts, including when the user wants a coding agent to work tracker tickets unattended, work through a backlog or recurring chores, serve many repositories or a team from one worker (a self-hosted software factory), or keep code and keys on their own machines. Use for first-time setup, credentials, GitHub App or relay authorization, browser-assisted integration setup, and worker readiness checks; ongoing workspace policies and recurring schedules belong to devintern-workspace, and task dispatch and DevIntern PM setup are separate workflows.
---

# Set up DevIntern

Recommend a workspace worker as the standard DevIntern Code setup, including for a single repository: it acquires tasks, follows up on PRs, runs schedules, and keeps configuration in one place. Pair it with the hosted relay. Honor an explicit request for a one-off interactive CLI run (`devintern init`, then `devintern <TASK>`); that needs no service, sign-in, or worker entitlement. A successful standalone task does not complete a requested worker setup.

References: the [quick start](https://devintern.com/docs/code/quick-start), [worker guide](https://devintern.com/docs/code/worker), and [configuration guide](https://devintern.com/docs/code/configuration). In a source checkout they are under `docs/code/`. Do not assume a source checkout or other DevIntern skills are present. Check `--help` of the installed CLI before using any flag below; if a flag is missing, the CLI is older than this skill: follow [Older CLIs](references/legacy-cli.md).

Read [Integrations](references/integrations.md) when configuring source control, tracker credentials, provider authorization, or relay connections. Code-host access, tracker access, DevIntern sign-in, and agent authentication are four separate checks.

## Ground rules

- **No prompts.** Run every command with `--non-interactive`, `--json`, or `--no-wait` as given below. Never pipe guessed answers into `devintern worker init` (without `--non-interactive`) or `devintern init`, never drive them through a pseudo-terminal, and never run a command that waits for a browser: bare `devintern worker login <method>`, bare `devintern worker connect`, or foreground `devintern worker`.
- **Secrets stay out of chat and flags.** Credentials go in an owner-only env file the user writes on the worker host; report only presence and validation results. Never print `.env`, session, or relay files. The one exception is the sign-in callback address in step 4.
- **Reuse and preserve.** Keep working configuration, authentication, repository and team names, delivery choices, and file permissions. The default workspace is `~/.devintern/workspace.toml`; honor `DEVINTERN_WORKSPACE_DIR` and pass `--workspace <path>` for a nondefault one.
- **Read JSON, not prose.** Each `--json` command prints one document on stdout. Treat an unknown `result` value as not ready. `nextSteps[].command` may be a blocking form (see step 3); use the commands from this skill instead.
- **Trial runs need consent.** A task run edits files, moves tickets, posts comments, and opens PRs. Do not run `devintern --query` as a connection test.

## Runbook

### 0. Ask the user

Ask once, up front, and record the answers:

1. The worker host (this machine, or which server) and the repository (`owner/repo`).
2. The coding agent CLI: Claude Code (default), Codex, OpenCode, Cursor, or another [harness](https://devintern.com/docs/code/agent-harness).
3. The tracker and the ready-tasks query in its language, kept narrow. For GitHub Issues, suggest `is:open label:devintern`; JQL such as `labels = x` is accepted silently on GitHub and matches nothing.
4. The branch PRs should target. The default is the repository's default branch.
5. How they sign in on devintern.com: `github`, `google`, `x`, or their email address. Skip when they have a paid `LICENSE_KEY` and want no relay.
6. Whether to install the background service now. It starts picking up matching tickets right away.

### 1. Prerequisites on the worker host

1. Check `bun --version`, `git --version`, `command -v devintern`, and the agent CLI (`command -v claude`, `codex`, …).
2. Missing Bun: `curl -fsSL https://bun.sh/install | bash` (on Debian/Ubuntu it needs `unzip`; ask the user to install it if `apt-get` needs sudo). The installer only edits shell profiles, so in the same non-interactive shell run `export PATH="$HOME/.bun/bin:$PATH"`.
3. Missing DevIntern: `bun install -g @getdevintern/code`.
4. Missing agent CLI: follow its official install. For Claude Code use `bun install -g @anthropic-ai/claude-code`; npm may be absent on a Bun-only host. Finding the executable does not prove it is signed in. Hand-off: ask the user to run the agent once on the worker host and sign in (for Claude Code, `claude` then `/login`), because you cannot do it for them.

### 2. Checkout and credentials

1. Ask the user to write the credentials on the worker host, outside any repository, and tell you only the path:

   ```bash
   umask 077
   cat > ~/devintern.env <<'EOF'
   GITHUB_TOKEN=<token>
   AGENT_HARNESS=claude-code
   EOF
   ```

   Add the tracker's variables (for example `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`; see [Integrations](references/integrations.md)). `AGENT_HARNESS` is `claude-code`, `codex`, `opencode`, `cursor`, or another harness id; there is no flag for it. For GitHub, suggest a fine-grained token limited to the repository with Contents, Pull requests, and Issues set to Read and write and Metadata Read (created at `https://github.com/settings/personal-access-tokens/new`), or a classic token with the `repo` scope. The file must be mode `0600`.
2. Get a checkout of the repository on the worker host if none exists. The worker keeps its own clone, so a shallow clone is enough; the checkout identifies the repository through its `origin` remote. For a private HTTPS repository, use the token without writing it to disk or the remote URL:

   ```bash
   set -a; . ~/devintern.env; set +a
   git -c credential.helper='!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f' \
     clone --depth 1 https://github.com/<owner>/<repo>.git
   ```

   After setup, the worker uses `GITHUB_TOKEN` for `https://github.com` remotes when git has no credential helper of its own. An SSH remote needs a key the background service can use without a terminal (no passphrase prompt, no desktop agent).

### 3. Configure the workspace

Inside the checkout:

```bash
devintern worker init --non-interactive --tracker <id> --task-query '<query>' \
  --repo-from-cwd --env-file ~/devintern.env --sign-in <method> --json
```

Stdout is `schema` `devintern.worker-init`, `version` 1. Read:

| Field | Meaning |
| --- | --- |
| `result` | `success` (exit 0, ready), `action_required` (exit 2, saved and nothing broken; only sign-in is left), `failure` (exit 1). `action_required` is not a broken setup |
| `error` | Input problem; names every missing flag and variable |
| `checks[]` | `name`, `label`, `status` (`pass`, `warn`, `action`, `fail`, `skipped`), `message`, `hint`. A `query` warn with 0 matches is fine when nothing is labelled yet |
| `signIn` | `url`, `method`, `expiresAt`, `complete`; present when `--sign-in` started a sign-in (step 4) |
| `nextSteps[]` | `id`, `message`, `command`. Ids: `sign-in`, `add-repo`, `install-agent`, `connect`, `start`, `service` |

Map the next steps to headless commands: `sign-in` is step 4, `connect` is step 6, `service` and `start` are step 5. `install-agent` means the agent CLI was not found: do step 1.4 (prefer `bun install -g` when the suggested command uses npm and npm is absent), then rerun `devintern worker doctor --json`; `start` and `service` are withheld until then.

Init writes its files even when a check fails. To change the tracker, query, or repository afterwards, rerun the same command with `--yes`; it updates only what the flags name and keeps other settings. Confirm with the user before passing `--yes` to a workspace they already had.

After a successful init, `~/devintern.env` is copied into `~/.devintern/.env`; tell the user they can delete the source file.

**PR target branch.** When PRs should target a branch other than the repository default, edit `~/.devintern/workspace.toml` and add `--pr-target-branch <branch>` to `[defaults].worker_task_args`, keeping `--create-pr`:

```toml
[defaults]
worker_task_args = "--create-pr --pr-target-branch develop"
```

**Status labels and states.** Map tracker statuses under `[trackers]` in `workspace.toml`, after reading the names that exist in the tracker; see the provider guide linked from [Integrations](references/integrations.md). Basic setup needs none.

### 4. Sign in (Worker Pilot)

The 14-day free Worker Pilot (no card required) belongs to the user's DevIntern account, so the worker host needs a sign-in even with no one at it. A paid `LICENSE_KEY` in the workspace `.env` replaces it, but relay pairing still needs a sign-in.

1. Use `signIn` from step 3, or run `devintern worker login <method> --no-wait --json` (`result` `pending` with `url`, `expiresAt`, `complete`).
2. Hand-off: show the user `url` (for email there is none: the link arrives in their inbox) and `expiresAt`. Tell them that after signing in the browser lands on a `127.0.0.1` page that does not load, which is expected, and to copy that page's full address.
3. Either the user runs the `complete` command on the worker host with the address in single quotes, or they paste the address to you and you run `devintern worker login --complete '<address>' --json` at once. Pasting it is allowed: it holds a single-use code that works only with the verifier stored owner-only on this host. Use it only in that command, and never ask for anything else (tokens, session files, `.env` values).
4. `result` `signed_in` (exit 0) finishes it. The pending sign-in expires 30 minutes after it starts. Each new `--no-wait` or `--sign-in` run replaces the previous one and invalidates its URL, so do not rerun it while the user is signing in, and show only the newest URL. On `failure` (expired, used, wrong host), start again from 4.1.

### 5. Check readiness and start the service

1. Run `devintern worker doctor --json` (`schema` `devintern.worker-doctor`). Same `checks[]` and `nextSteps[]` shapes as init. `failure` (exit 1) blocks: fix the failing checks from their `hint`. `action_required` (exit 2) means only sign-in is left: do step 4. Report every `warn` check to the user.
2. Check that nothing else runs this workspace: `devintern worker service status --json` (`result` `not_installed` when there is no service) and `devintern worker status --json`. Do not start a second worker.
3. With the user's go-ahead (step 0.6), run `devintern worker service install --json`. It repeats the doctor checks, installs a systemd user unit (Linux) or launchd agent (macOS), starts it, and waits for the worker. `result` and exit code:

   | `result` | Exit | Meaning |
   | --- | --- | --- |
   | `running` | 0 | The worker is up; the document has the pid and dashboard address |
   | `action_required` | 2 | Refused: only sign-in is left. Do step 4, then install again |
   | `refused` | 1 | Refused: `checks` lists the failures; fix them and install again |
   | `failed` | 1 | Started but the worker exited: `start.reason` and `start.logLines` say why. `start.permanent` means it stopped retrying; fix it, then `devintern worker service restart --json` |
   | `starting` | 3 | Not up yet; check again with `devintern worker service status --json` |

   Report `failed` and `starting` as not running. Use `--force` only when the user accepts a worker that cannot start yet. Relay every entry of `warnings`, notably the linger warning: the user runs `sudo loginctl enable-linger <user>` once, or the worker stops at logout. Running `install` again restarts a running worker, so do not repeat it to check status.

### 6. Pair the relay

After sign-in, for GitHub:

1. `devintern worker connect github --no-wait --json` (`schema` `devintern.worker-connect`). `connected` (exit 0) means done. `pending` (exit 0) has a next step `authorize-github-app` whose URL (`pairing.authorizeUrl` when `pairing.appInstalled` is true, otherwise `pairing.installUrl`) the user opens in any browser to approve the DevIntern GitHub App, selecting only the intended repositories. `action_required` (exit 2) means no sign-in: do step 4. Its stderr may say a pairing "failed"; the JSON is authoritative.
2. When the user says they approved, run `devintern worker connect github --status --json`. `pending` means not approved yet: wait for the user instead of looping. `failure` with `code` `pairing_expired` means start again at 6.1. With several GitHub accounts, repeat until nothing is pending.
3. Other trackers (Linear, Asana, Trello, Azure DevOps, GitLab) use `devintern worker connect <target> --json`; Jira prints a private ingest URL the user pastes into Jira's admin webhooks. See [Integrations](references/integrations.md). GitHub Issues needs no separate tracker pairing.

Skip this step when the user chose polling only. Polling keeps working without the relay.

### 7. Verify and report

Setup is done when all of these hold:

- `devintern worker doctor --json` returns `result` `success` (exit 0) with no `fail` checks and no `sign-in` or `install-agent` next step. Before the service starts, `nextSteps` still offers `start` and `service`; once a worker runs, it is empty.
- `devintern worker service status --json` reports `running` (or the user chose not to start it).
- `devintern worker status --json` shows the worker running.

For a running worker, `devintern worker overview --json` shows harness and tracker health, `devintern worker logs --level warn` shows recent problems, and `devintern worker runs --json` and `devintern worker prs --json` show the first task and its PR.

Report separately, citing the `worker doctor` result: **configured** (host, workspace, repository, tracker, query, PR target), **credentials verified** (code host, tracker, sign-in or license, agent), **relay** connected or polling only, and **worker** running or intentionally stopped. List the user actions still open (sign-in, App approval, agent sign-in, linger) and any check you could not run. Then tell the user how to hand over work, for example: "Add the `devintern` label to an issue; the worker polls every 60 seconds and opens a PR against `<branch>`." Never include tokens, session data, or private ingest URLs.

## Beyond basic setup

- A person at a terminal can run the guided `devintern worker init` wizard instead of steps 3 to 6. `--no-service` skips its service offer.
- Credential layers: shared worker credentials in the workspace `.env`, repository credentials in repo env layers, tracker credentials in team layers. A checkout's own `.env` is not loaded by the worker. See [workspace configuration](https://devintern.com/docs/code/workspaces).
- Several tracker sources use `[[teams]]` and routing rules; a single repository needs none. For ongoing workspace changes, automations, Sentry monitors, and policies, use `devintern-workspace` when available. For one-off dispatch, use `devintern-delegate`.
- Sentry without a terminal: `devintern worker connect sentry --org <slug> --project <slug> [--repo <name>] --json`, with `SENTRY_AUTH_TOKEN` in the environment or a `0600` `--env-file`. Changing an existing monitor needs `--yes`; confirm first.
- Browser help: when browser automation is available (browser-use, Chrome DevTools Protocol, or another tool), use an already authorized session to complete provider steps such as GitHub App approval or tracker webhook settings. Let the user handle login, MFA, and admin approval, then verify the result with the CLI.
- Changes to shared tracker credentials, tracker or team identity, or dashboard settings need `devintern worker service restart --json`. Repository, query, and routing edits reload on their own; check `devintern worker logs --level warn` afterwards.
- Never activate a paid subscription to complete setup.
