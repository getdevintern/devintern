---
name: devintern-setup
description: Install DevIntern Code, set up a worker, or connect source control and task tracker accounts. Use for first-time setup, credentials, GitHub App or relay authorization, browser-assisted integration setup, and verifying worker readiness. Ongoing workspace policies and recurring schedules belong to devintern-workspace; task dispatch and DevIntern PM setup are separate workflows.
---

# Set up DevIntern

Get the requested DevIntern Code workflow working on the intended host. Distinguish a one-off interactive CLI run from an unattended workspace worker; do not install a resident service when the user only wants to try a task.

Use the [quick start](https://devintern.com/docs/code/quick-start), [configuration guide](https://devintern.com/docs/code/configuration), and [worker guide](https://devintern.com/docs/code/worker). In a source checkout, read the corresponding `docs/code/*.md` files and implementation when needed. Installed skills must not assume a source checkout or other DevIntern skills are present. Check installed command help before using flags from newer documentation.

## Establish the destination and existing state

Identify the execution host, repository remotes, chosen agent, task source, and desired PR/review behavior. Reuse working configuration and authentication. Inspect credential names and presence without printing values; do not dump `.env`, session, or relay files into tool output. Preserve existing settings, repository/team identifiers, and file permissions.

The default worker config is `~/.devintern/workspace.toml`. Honor `DEVINTERN_WORKSPACE_DIR` and explicit `--workspace /path/to/workspace.toml` selections on commands that support them. Secrets, git credentials, and agent authentication must work on the worker host, even when authorization happens in a browser on another machine.

Read [Integrations](references/integrations.md) when configuring source control, tracker credentials, provider authorization, or relay connections. Code-host access, task-tracker access, DevIntern sign-in, and agent authentication are separate checks.

## Prepare the runtime and configuration

- Check Bun, Git, `devintern`, and the selected agent CLI on the execution host. If installation is requested and DevIntern is absent, use `bun install -g @getdevintern/code`. Follow the runtime or selected agent's official instructions when those prerequisites are absent; preserve the user's agent choice. Configure `AGENT_HARNESS` in the environment used by the worker. Finding the executable alone does not prove the agent is authenticated.
- For a guided terminal setup, `devintern init` configures project credentials and settings; `devintern worker init` builds on that to configure a worker, validate the task query, offer relay pairing, and optionally install/start a user service. These are interactive wizards: do not pipe guessed answers into them or rerun a wizard indiscriminately over an existing workspace. `worker init --no-service` skips the service offer.
- For agent-driven setup without terminal prompts, `devintern init --yes` writes project templates; it does not validate filled-in credentials. `devintern worker scaffold` creates the workspace, and `devintern worker add-repo` registers the current checkout. Registration imports project `.devintern-code/.env`: absent keys merge into workspace `.env`, conflicts become `[repos.env]` overrides. These commands alone do not connect accounts, select work, or start a service. Inspect help for custom workspace support; edit the selected config directly if a setup command cannot target it.
- Store shared worker credentials in workspace `.env`, repo credentials in repo environment layers, and tracker credentials in the relevant team layers. Prefer owner-only secret files, preserve `0600`, and keep secrets out of version control and summaries. A checkout's project `.env` is not automatically loaded by workspace execution. See [workspace configuration](https://devintern.com/docs/code/workspaces) for exact precedence and routing.
- For unattended work, check an active Worker Pilot or automation license. Use `devintern worker login [method] --workspace /path/to/workspace.toml` when worker sign-in is needed and supported; project `devintern login` alone is not proof that the selected worker is signed in. Paid license use does not by itself require sign-in; hosted relay pairing does. Never activate a paid subscription merely to complete setup.

Configure only the requested sources and policies. A single repo needs no routing rules. Multiple tracker sources use `[[teams]]`; a team fixed to one codebase can set `repo`, otherwise use unambiguous routing rules. Select a narrow, user-intended ready-work query in the tracker's query language. Do not execute `devintern --query` as a read-only connection test: it can process matching tasks. Automations can run without tracker credentials or a polling query; the current schema still requires `[defaults].tracker`.

For detailed workspace changes, use `devintern-workspace` when available, or consult the workspace guide directly. Recurring prompts, estimation sweeps, Sentry monitor policies, pipelines, quiet hours, and concurrency do not need to be enabled for basic setup. One-off dispatch uses `devintern-delegate` when available.

## Verify and activate

Use read-only provider checks for the intended repository, tracker project, query, and configured workflow states. Validate the TOML and relevant schema; there is no assumed `worker validate` command. `devintern doctor` checks readiness in its loaded project/environment context, not every repo/team in a workspace; inspect its output before claiming it tested remote credentials or worker authentication. Use `devintern worker connect status --workspace /path/to/workspace.toml` for relay pairing status, not as a complete worker health check.

Before starting a worker, inspect whether a service or daemon already owns the selected workspace. Startup begins acquiring eligible work. Start the worker or install/start its user service when the user's requested setup includes activation; do not launch a second daemon. Follow the installed wizard's generated service instructions or the [service guide](https://devintern.com/docs/code/worker#running-as-a-service), including Bun/agent PATH and unattended git authentication. Do not invent `worker service install`. Changes to shared tracker credentials, tracker/team identity, or dashboard/startup settings require a restart; ordinary repo/query/routing edits can reload. Verify logs show that the requested configuration was accepted.

Only run a trial task when covered by the user's request: it can modify files, transition tracker tickets, post comments, and create PRs. Configuration validation and successful authorization are not proof that an implementation ran successfully.

Report the selected host/config, repositories and task sources, and evidence separately for: **configured**, **credentials verified**, **relay connected or polling-only**, and **worker running or intentionally stopped**. Identify remaining browser/user actions and any checks that could not be performed. Never include tokens, session data, or private ingest URLs.
