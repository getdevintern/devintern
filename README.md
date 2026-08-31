# DevIntern

<p align="center">
  <a href="https://devintern.com">
    <img src="https://devintern.com/marketing/logo/logo.rect.dark.small.png" alt="DevIntern" width="280">
  </a>
</p>

<p align="center">
  <strong>A worker for the coding agents you already have. Ready tickets become reviewed pull requests — on your machines.</strong>
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
<p align="center"><em>Try it on one task. The product is the worker that keeps going.</em></p>

<!-- Fallback GIF if video is awkward on some clients
<p align="center">
  <img src="https://github.com/user-attachments/assets/YOUR-GIF-ID" width="820" alt="DevIntern: markdown task becomes a pull request">
</p>
-->

DevIntern is a self-hosted worker: it picks up ready tickets from the tracker you already use, runs Claude Code, Codex, Cursor, or OpenCode with your keys, and opens a self-reviewed pull request. You review diffs, not agent sessions. Interactive runs are free; the daemon is the paid product.

- **Your tracker:** Jira · Linear · GitHub Issues · Trello · Asana · Azure DevOps · plain markdown files
- **Your agent:** Claude Code · Codex · Cursor · OpenCode (one config line to switch)
- **Your keys, your machines** — billed on the contract you already have; code never hits our servers
- **Try it free** — run `devintern PROJ-123` from your terminal, no signup

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

<p align="center">
  <a href="docs/code/quick-start.md"><strong>Docs</strong></a>
  ·
  <a href="https://www.npmjs.com/package/@getdevintern/code"><strong>npm</strong></a>
  ·
  <a href="https://devintern.com"><strong>Website</strong></a>
  ·
  <a href="https://devintern.com/pm-desktop/"><strong>PM desktop</strong></a>
  <!-- · <a href="YOUR-DISCORD-OR-DISCUSSIONS-URL"><strong>Community</strong></a> -->
</p>

## Quick start

```bash
# Requires Bun
curl -fsSL https://bun.sh/install | bash
bun install -g @getdevintern/code

# 1. Try one task in this repo (free, no signup)
devintern init
devintern ./tasks/my-task.md --create-pr   # or: devintern PROJ-123 --create-pr

# 2. Leave it running (automation license)
devintern worker init
devintern worker
```

One local run proves the loop. The worker is the intern: it keeps picking up ready tickets and turns review comments on its pull requests into commits.

## Why teams use it

|                     |                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Worker**          | One daemon. Ready tickets become pull requests. Review comments come back as commits on the same branch.                         |
| **Your stack**      | Your tracker, your coding agent, your keys. DevIntern runs the tools you already use instead of selling you another agent.        |
| **Quality gates**   | Vague tickets get questions on the tracker instead of a wrong PR. The agent reviews its own diff before a human sees it.          |
| **Self-hosted**     | Runs on a laptop or VM you control. Your code and credentials stay there; the source is available under the FSL.                  |

## The worker

`devintern worker` is a long-running daemon that polls your tracker, implements ready tickets, opens pull requests, and keeps its own PRs healthy while your team writes specs, reviews code, or sleeps. Your code, credentials, and agent execution never leave your machine.

Once it's running, the worker:

- **Drains the backlog** — picks up every ticket matching your ready-tasks query (`task_query`) and runs the full pipeline per repo, one at a time; attempts that come up incomplete bounce back to the tracker with an explanation instead of disappearing.
- **Keeps up with review feedback** — watches the PRs it created; when someone requests changes or comments, the same pipeline addresses the feedback and pushes commits. No webhook plumbing needed in polling mode.
- **Resolves merge conflicts itself** — merges the base branch tip into a lagging PR branch and asks the agent to fix conflicts semantically, never force-pushing over human work.
- **Takes orders by @mention** — comment `@devintern address the review feedback` on _any_ PR in the repo and it handles it (only users with push access can direct the bot).
- **Runs scheduled chores** — automations turn a cron schedule plus a prompt into the full ticket→PR pipeline, like dependency upgrades or flaky-test triage on Monday mornings. The prompt is the task: nothing needs to exist in your tracker.
- **Survives reality** — accepted work persists to a local SQLite queue across restarts, retries are capped, and rate limits pause rather than break runs.
- **Shows its work** — every run is recorded stage-by-stage in a built-in dashboard at `http://localhost:4400`; routing rules and automations span a whole fleet of repositories from one `workspace.toml`.

Set it up once:

```bash
devintern worker init    # guided setup: reuses tracker config, checks license, pairs relay, can install systemd/launchd service
devintern worker         # keeps running: polling, reviews, automations, dashboard
```

A slice of `workspace.toml` shows most of the story:

```toml
[defaults]
task_query = "status=todo"
worker_task_args = "--create-pr"
poll_interval = 60

[[automations]]
id = "dependency-health"
enabled = true
interval = "6h"
prompt = """Pick one outdated dependency and upgrade it within the same major version."""
```

For teams this changes what "keeping the repo healthy" costs: maintenance tickets stop rotting in the backlog, review cycles close themselves while reviewers stay in the loop where their input actually matters, and recurring chores run like cron jobs whose output arrives as reviewed pull requests rather than good intentions.

Unattended automation uses the paid automation tier (one-time Supporter license or Team/Business subscription) — interactive use stays free forever. [Pricing](https://devintern.com/pricing/) · [Worker docs](docs/code/worker.md)

<!-- Optional: secondary visuals (feasibility comment on a ticket, self-review, worker dashboard)
<p align="center">
  <img src="https://github.com/user-attachments/assets/FEASIBILITY-ID" width="400" alt="Feasibility questions posted on the ticket">
  <img src="https://github.com/user-attachments/assets/PR-DETAIL-ID" width="400" alt="Self-reviewed pull request">
</p>
-->

## Try one task

Point the CLI at a ticket and get a reviewed diff back. Interactive use is free forever: no signup, no time limit.

| Command                                            | What you get                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `devintern PROJ-123 --create-pr`                   | Ticket → feature branch → implemented diff → PR, with a summary posted back to the tracker        |
| `devintern ./tasks/my-task.md --create-pr`         | The same loop from a local markdown file — zero tracker credentials                               |
| `devintern --query 'status = "To Do"' --create-pr` | Batch mode: every ticket matching your JQL / Linear filter / GitHub search, run one after another |
| `devintern PROJ-123 --create-pr --auto-review`     | The agent critiques its own PR diff and commits fixes before any human has to look                |
| `devintern address-review <pr-url>`                | Review comments on a pull request become addressed commits on its branch                          |
| `devintern resolve-conflicts <pr-url>`             | The base branch is merged in and the agent resolves the conflicted files sensibly                 |
| `devintern doctor`                                 | Pre-flight check for runtime, git, agent CLIs, tracker credentials — with a fix hint per problem  |

When a ticket is too vague to implement responsibly, the agent posts clarifying questions back on the tracker instead of shipping a confidently wrong PR. See the [quick-start guide](docs/code/quick-start.md) and [full usage reference](docs/code/usage.md).

## Need a ticket first?

[DevIntern PM](https://devintern.com/pm-desktop/) (desktop, free) and [`devpm`](https://www.npmjs.com/package/@getdevintern/pm) turn a prompt, error log, or Figma frame into a well-specified tracker ticket. They are optional intake for the worker.

## License and pricing

Source is under the [Functional Source License, Version 1.1, with Apache 2.0 Future License](LICENSE.md) (FSL-1.1-Apache-2.0). You can read it, audit it, self-build, and self-host. Each release converts to Apache-2.0 two years after publication.

- **Interactive use** → free forever
- **Worker (unattended)** → Supporter ($99 once for one person's own repos) or a Team/Business subscription

Details: [devintern.com/pricing](https://devintern.com/pricing/)

The FSL grants no trademark rights: the DevIntern name and logo are trademarks of Daniil Pokrovsky (devintern.com) and may not be used to identify forks or derived products.

## Repository layout

| Package                                        | Purpose                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| [`@getdevintern/code`](packages/code)          | The `devintern` CLI: ticket → agent → self-reviewed PR           |
| [`@getdevintern/pm`](packages/pm)              | The `devpm` CLI: rough input → well-specified tickets            |
| [`@devintern/pm-desktop`](packages/pm-desktop) | Desktop app for ticket drafting: prompt, log, or Figma → tracker |
| `packages/*` (shared)                          | Agent harness, tracker clients, auth, license check, utilities   |

Website and control plane live elsewhere; this repo is the tool packages.

## Development workflows

Install dependencies with `bun install`, then use the root commands below. Turborepo runs package tasks in parallel where it is safe and orders workspace builds according to their package dependencies.

| Command                | Purpose                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `bun run build`        | Build every workspace and its dependencies                                    |
| `bun run test`         | Run all package test suites                                                   |
| `bun run lint`         | Lint all packages                                                             |
| `bun run typecheck`    | Type-check all packages                                                       |
| `bun run format:check` | Check formatting without changing files                                       |
| `bun run format`       | Format all packages; this write task is intentionally not cached              |
| `bun run dev`          | Start the dashboard and desktop watch tasks; stop them with <kbd>Ctrl+C</kbd> |

Package-level commands remain available, for example `bun run --filter @getdevintern/pm test`. To run a selected task and its dependency graph through Turborepo, use `bun run turbo run build --filter @getdevintern/code`.

Turborepo uses the local `.turbo` directory for its cache; remote caching is not configured. Add `--force` to a Turbo command to ignore cached results, or remove `.turbo` to clear the local cache completely. If a result looks stale, first rerun it with `--force`; changes to the lockfile, package sources, shared lint configuration, or declared build environment variables automatically invalidate affected entries.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Monorepo layout and Bun-only tooling: [AGENTS.md](AGENTS.md).

Built for teams that want agents to close tickets, not just write code.
