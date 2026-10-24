# DevIntern

<p align="center">
  <a href="https://devintern.com">
    <img src="https://devintern.com/marketing/logo/logo.rect.dark.small.png" alt="DevIntern" width="280">
  </a>
</p>

<p align="center">
  <strong>Keep your coding agent working through your backlog.</strong>
</p>

<p align="center">
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/License-FSL--1.1--Apache--2.0-blue" alt="License"></a>
  <a href="https://devintern.com"><img src="https://img.shields.io/badge/Website-devintern.com-blue" alt="Website"></a>
  <a href="https://www.npmjs.com/package/@getdevintern/code"><img src="https://img.shields.io/npm/v/%40getdevintern%2Fcode?label=%40getdevintern%2Fcode" alt="npm"></a>
  <a href="https://github.com/getdevintern/devintern"><img src="https://img.shields.io/github/stars/getdevintern/devintern?style=social" alt="Stars"></a>
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/f62b17c0-4e5b-4a2f-ac3a-761c44af3680" width="100%" controls muted autoplay loop playsinline></video>
</p>
<p align="center"><em>Ready ticket → pull request → review feedback → follow-up commits.</em></p>

DevIntern is a self-hosted worker that picks up ready tickets from Jira, Linear, GitHub Issues, or your other trackers, runs Claude Code, Codex, Cursor, or OpenCode, and opens pull requests. When reviewers request changes, it follows up on the same branch. Your team controls what gets picked up and what gets merged.

<p align="center">
  <a href="#set-up-your-worker"><strong>Set up your worker</strong></a>
  &nbsp;·&nbsp;
  <a href="#see-it-working">Real pull requests</a>
  &nbsp;·&nbsp;
  <a href="docs/code/worker.md">Documentation</a>
  &nbsp;·&nbsp;
  <a href="https://devintern.com">Website</a>
</p>

Try unattended automation free for 14 days with the Worker Pilot. Sign-in required; no credit card or task-count limit. Continued automation requires a license. Bring your existing coding agent; its usage costs are separate.

- **Your tracker:** Jira · Linear · GitHub Issues · Trello · Asana · Azure DevOps · plain markdown files
- **Your agent:** Claude Code · Codex · Cursor · OpenCode (one config line to switch)
- **Your keys, your machines** — agent execution runs locally; your code never hits DevIntern servers
- **The whole review loop** — ready tickets become PRs; reviewer feedback becomes follow-up commits

<!-- Visual echo of the tracker + agent bullets above.
     Near-black brand marks use color/dark_mode_color so they stay visible
     under prefers-color-scheme (GitHub light + dark). -->
<p align="center">
  <img src="https://cdn.simpleicons.org/jira/0052CC" height="22" alt="Jira" title="Jira" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/linear/5E6AD2" height="22" alt="Linear" title="Linear" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/github/181717/ffffff" height="22" alt="GitHub Issues" title="GitHub Issues" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/trello/0052CC" height="22" alt="Trello" title="Trello" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/asana/F06A6A" height="22" alt="Asana" title="Asana" />
  &nbsp;
  <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/azure/azure-original.svg" height="22" alt="Azure DevOps" title="Azure DevOps" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/markdown/000000/ffffff" height="22" alt="Markdown" title="Markdown files" />
  &nbsp;&nbsp;
  <img src="https://cdn.simpleicons.org/claude/D97757" height="22" alt="Claude Code" title="Claude Code" />
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.iconify.design/simple-icons/openai.svg?color=%23ffffff" />
    <img src="https://api.iconify.design/simple-icons/openai.svg?color=%23000000" height="22" alt="Codex" title="Codex" />
  </picture>
  &nbsp;
  <img src="https://cdn.simpleicons.org/cursor/000000/ffffff" height="22" alt="Cursor" title="Cursor" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/opencode/000000/ffffff" height="22" alt="OpenCode" title="OpenCode" />
</p>

## Set up your worker

Start in a Git repository on the machine that will run the worker. You need [Bun](https://bun.sh), an installed and authenticated coding agent, and access to your tracker and source-control host.

```bash
# Install Bun if needed
curl -fsSL https://bun.sh/install | bash
bun install -g @getdevintern/code

# Guided setup: connect your tracker, choose ready tickets, activate automation
devintern worker init
# If the wizard did not start a service, start manually:
# devintern worker
```

The wizard configures your ready-tasks query and operating policy, checks automation access, and offers to install and start a background service. Without a paid license, it offers sign-in for the 14-day Worker Pilot.

Start with a narrow queue of well-specified tasks. Watch the runs in the local dashboard at `http://localhost:4400`, review the resulting PRs, and leave feedback on their branches. The worker picks up that feedback and pushes follow-up commits.

Prefer guided setup through your coding agent? Use the [DevIntern setup skill](docs/code/agent-skills.md). Want to inspect one run first? [Run one ticket first](#run-one-ticket-first).

## Why teams use it

| Capability        | What it does                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worker**        | One daemon. Ready tickets become pull requests. Review comments come back as commits on the same branch.                                                       |
| **Your stack**    | Your tracker, your coding agent, your keys. DevIntern runs the tools you already use instead of selling you another agent.                                     |
| **Quality gates** | Vague tickets get questions on the tracker instead of a wrong PR. Enable optional auto-review to have the agent critique and fix its diff before human review. |
| **Self-hosted**   | Runs on a laptop or VM you control. Your code and credentials stay there; the source is available under the FSL.                                               |

## What the worker does

`devintern worker` is a long-running daemon that polls your tracker, implements ready tickets, opens pull requests, and keeps its own PRs healthy while your team writes specs, reviews code, or sleeps. Agent execution runs on your machine. Your code and credentials never pass through DevIntern servers; your configured agent, tracker, and source-control providers handle their own requests.

Once it's running, the worker:

- **Drains the backlog** — picks up every ticket matching your ready-tasks query (`task_query`) and runs the full pipeline per repo, one at a time; attempts that come up incomplete bounce back to the tracker with an explanation instead of disappearing.
- **Keeps up with review feedback** — watches the PRs it created; when someone requests changes or comments, the same pipeline addresses the feedback and pushes commits. No webhook plumbing needed in polling mode.
- **Resolves merge conflicts itself** — merges the base branch tip into a lagging PR branch and asks the agent to fix conflicts semantically, never force-pushing over human work.
- **Takes orders by @mention** — comment `@devintern address the review feedback` on _any_ PR in the repo and it handles it (only users with push access can direct the bot).
- **Runs scheduled chores** — automations turn a cron schedule plus a prompt into the full ticket→PR pipeline, like dependency upgrades or flaky-test triage on Monday mornings. The prompt is the task: nothing needs to exist in your tracker.
- **Fixes production errors from Sentry** — add a Sentry project during `worker init`, or run `worker connect sentry` for an existing workspace. The worker watches recurring error groups, turns valid ones into bugfix tasks, and ships the fix through the same pipeline as a reviewed pull request.
- **Survives reality** — accepted work persists to a local SQLite queue across restarts, retries are capped, and rate limits pause rather than break runs.
- **Shows its work** — every run is recorded stage-by-stage in a built-in dashboard at `http://localhost:4400`; routing rules and automations span a whole fleet of repositories from one `workspace.toml`.

### Configure the fleet

One `workspace.toml` covers every repository, team, and automation. A slice:

```toml
[defaults]
task_query = "status=todo"
worker_task_args = "--create-pr"
poll_interval = 60

[[automations]]
id = "dependency-health"
enabled = true
interval = "6h"
open_pr = true
prompt = """Pick one outdated dependency and upgrade it within the same major version."""
```

For teams this changes what "keeping the repo healthy" costs: maintenance tickets stop rotting in the backlog, review cycles close themselves while reviewers stay in the loop where their input actually matters, and recurring chores run like cron jobs whose output arrives as reviewed pull requests rather than good intentions.

Sign in to evaluate unattended automation with a no-card Worker Pilot: 14 days with no task-count limit. Continued use requires the paid automation tier (one-time Supporter license or Team/Business subscription); interactive use stays free forever. [Pricing](https://devintern.com/pricing/) · [Worker docs](docs/code/worker.md)

## See it working

Browse the [DevIntern-authored pull requests](https://github.com/getdevintern/devintern/pulls?q=is%3Apr+label%3Adevintern-authored) to inspect changes produced by DevIntern on this repository. Start with these merged examples:

- [Worker daemon smoke coverage and PR label checks (#306)](https://github.com/getdevintern/devintern/pull/306)
- [Sandbox-aware coding-agent readiness (#300)](https://github.com/getdevintern/devintern/pull/300)
- [Per-agent state directories in the sandbox (#296)](https://github.com/getdevintern/devintern/pull/296)

Open each PR to inspect its diff, checks, and discussion. The [full pull request list](https://github.com/getdevintern/devintern/pulls?q=is%3Apr+label%3Adevintern-authored) includes work still in review.

If DevIntern is useful to you, [star the repo](https://github.com/getdevintern/devintern) or share a workflow you have automated.

## Run one ticket first

Want to inspect the pipeline before leaving a worker running? Run a single ticket first. It does not keep watching your backlog or responding to review feedback. Interactive runs are free forever, with no signup and no time limit.

```bash
devintern init                              # connect a tracker, or pick Markdown for a local spec
# Choose one: a ticket in your configured tracker, or an existing local task file
devintern PROJ-123 --create-pr
# Or: devintern ./tasks/my-task.md --create-pr
```

Opening a PR requires source-control access. For a local spec, choose Markdown during setup and create your task file first. The [quick-start guide](docs/code/quick-start.md) walks through setup.

When a ticket is too vague to implement responsibly, the agent posts clarifying questions on the tracker instead of shipping a confidently wrong PR.

Everything else the CLI can do — batch queries, `--auto-review`, `address-review`, `resolve-conflicts`, `doctor`, `report` — lives in the [usage reference](docs/code/usage.md). Delivery is a configurable pipeline: add built-in verification or your own project-local TypeScript steps with [Customizing the Task Pipeline](docs/code/pipelines.md) ([runnable examples](examples/pipeline-plugins/README.md)).

## Agent skills

Your coding agent can install, configure, and drive DevIntern on its own:

```bash
bunx skills add getdevintern/devintern \
  --skill devintern-setup devintern-workspace devintern-delegate devintern-report --agent codex
```

`--agent claude-code` for Claude Code, `--global` for user-wide availability. Four skills cover the whole worker lifecycle: [setup](skills/devintern-setup/SKILL.md), [workspace configuration](skills/devintern-workspace/SKILL.md), [delegating a task](skills/devintern-delegate/SKILL.md), and filing a [redacted bug report](skills/devintern-report/SKILL.md).

The skills are instructions for your agent. They do not install the CLI, connect accounts, or start a worker by themselves. See the [agent skills guide](docs/code/agent-skills.md) for prerequisites and example prompts.

## Need a ticket first?

[DevIntern PM](https://devintern.com/pm-desktop/) (desktop, free) and [`devpm`](https://www.npmjs.com/package/@getdevintern/pm) turn a prompt, error log, or Figma frame into a well-specified tracker ticket. They are optional intake for the worker.

## License and pricing

Source is under the [Functional Source License, Version 1.1, with Apache 2.0 Future License](LICENSE.md) (FSL-1.1-Apache-2.0). You can read it, audit it, self-build, and self-host. Each release converts to Apache-2.0 two years after publication.

- **Interactive use** → free forever
- **Worker Pilot** → 14 days with no task-count limit, no card required; `devintern login` required
- **Worker (unattended)** → Supporter ($99 once for one person's own repos) or a Team/Business subscription

Details: [devintern.com/pricing](https://devintern.com/pricing/)

The FSL grants no trademark rights: the DevIntern name and logo are trademarks of Daniil Pokrovsky (devintern.com) and may not be used to identify forks or derived products.

## Contributing

Bug reports, documentation improvements, and PRs are welcome. See the [contributing guide](CONTRIBUTING.md) for repository layout, local development, checks, and contribution requirements.

Built for teams that want agents to close tickets, not just write code.
