# DevIntern

<p align="center">
  <a href="https://devintern.com">
    <img src="https://devintern.com/marketing/logo/logo.rect.dark.small.png" alt="DevIntern" width="280">
  </a>
</p>

<p align="center">
  <strong>Turn tracker tickets into pull requests with any coding agent — on your keys, self-hosted.</strong>
</p>

<p align="center">
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/License-FSL--1.1--Apache--2.0-blue" alt="License"></a>
  <a href="https://devintern.com"><img src="https://img.shields.io/badge/Website-devintern.com-blue" alt="Website"></a>
  <a href="https://www.npmjs.com/package/@getdevintern/code"><img src="https://img.shields.io/npm/v/%40getdevintern%2Fcode?label=%40getdevintern%2Fcode" alt="npm"></a>
  <a href="https://github.com/getdevintern/devintern"><img src="https://img.shields.io/github/stars/getdevintern/devintern?style=social" alt="Stars"></a>
</p>

<!-- Hero demo (record markdown task → agent → PR; prefer short silent MP4 on a GitHub attachment URL)
<p align="center">
  <video src="https://github.com/user-attachments/assets/YOUR-ID" width="820" controls muted autoplay loop playsinline></video>
</p>
<p align="center"><em>Markdown task → coding agent → pull request</em></p>
-->

<!-- Fallback GIF if video is awkward on some clients
<p align="center">
  <img src="https://github.com/user-attachments/assets/YOUR-GIF-ID" width="820" alt="DevIntern: markdown task becomes a pull request">
</p>
-->

DevIntern connects the tracker your team already uses to the coding agent and model you choose. Tickets get implemented and self-reviewed in the background; you step in when a clean diff is ready. Swap any piece at any time.

- **Your tracker:** Jira · Linear · GitHub Issues · Trello · Asana · Azure DevOps · plain markdown files
- **Your agent:** Claude Code · Codex · Cursor · OpenCode (one config line to switch)
- **Your keys:** BYOK — billed on your existing provider contract
- **Interactive use is free forever** — no signup, no time limit

<!-- Visual echo of the tracker + agent bullets above -->
<p align="center">
  <img src="https://cdn.simpleicons.org/jira/0052CC" height="22" alt="Jira" title="Jira" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/linear/5E6AD2" height="22" alt="Linear" title="Linear" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/github/181717" height="22" alt="GitHub Issues" title="GitHub Issues" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/trello/0052CC" height="22" alt="Trello" title="Trello" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/asana/F06A6A" height="22" alt="Asana" title="Asana" />
  &nbsp;
  <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/azure/azure-original.svg" height="22" alt="Azure DevOps" title="Azure DevOps" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/markdown/000000" height="22" alt="Markdown" title="Markdown files" />
  &nbsp;&nbsp;
  <img src="https://cdn.simpleicons.org/claude/D97757" height="22" alt="Claude Code" title="Claude Code" />
  &nbsp;
  <img src="https://cdn.jsdelivr.net/npm/simple-icons@11.15.0/icons/openai.svg" height="22" alt="Codex" title="Codex" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/cursor/000000" height="22" alt="Cursor" title="Cursor" />
  &nbsp;
  <img src="https://cdn.simpleicons.org/opencode/000000" height="22" alt="OpenCode" title="OpenCode" />
</p>

<p align="center">
  <a href="https://devintern.com/docs/code/quick-start/"><strong>Docs</strong></a>
  ·
  <a href="https://www.npmjs.com/package/@getdevintern/code"><strong>npm</strong></a>
  ·
  <a href="https://devintern.com"><strong>Website</strong></a>
  <!-- · <a href="YOUR-DISCORD-OR-DISCUSSIONS-URL"><strong>Community</strong></a> -->
</p>

## Quick start

```bash
# Requires Bun
curl -fsSL https://bun.sh/install | bash
bun install -g @getdevintern/code

# Zero tracker credentials: pass a local markdown task
devintern ./tasks/my-task.md --create-pr
```

That is the full loop: **markdown task → agent run → pull request**. No Jira or Linear account required for the markdown path.

With a real tracker (after `devintern init`):

```bash
devintern init                 # interactive setup for your tracker + agent
devintern PROJ-123 --create-pr
```

Full tracker and agent guides: [devintern.com/docs](https://devintern.com/docs/code/quick-start/)

## Why teams use it

| Capability                | What it does                                                                      |
| ------------------------- | --------------------------------------------------------------------------------- |
| **Feasibility gate**      | Vague tickets get questions back on the tracker instead of a confidently wrong PR |
| **Self-review loop**      | The agent reviews and fixes its own diff before a human sees it                   |
| **Unattended automation** | Scheduled pickup; review comments become commits on the same branch               |
| **Real-world resilience** | Persistent queue, crash recovery, rate-limit pause/resume                         |

<!-- Optional: secondary visuals (feasibility comment on a ticket, self-review, worker dashboard)
<p align="center">
  <img src="https://github.com/user-attachments/assets/FEASIBILITY-ID" width="400" alt="Feasibility questions posted on the ticket">
  <img src="https://github.com/user-attachments/assets/PR-DETAIL-ID" width="400" alt="Self-reviewed pull request">
</p>
-->

Also available: **[`@getdevintern/pm`](https://www.npmjs.com/package/@getdevintern/pm)** (`devpm`) — turn rough notes, logs, or Figma into well-specified tickets, then run them with `devintern`.

## License and pricing

Source is under the [Functional Source License, Version 1.1, with Apache 2.0 Future License](LICENSE.md) (FSL-1.1-Apache-2.0). You can read it, audit it, self-build, and self-host. Each release converts to Apache-2.0 two years after publication.

- **Interactive use** → free forever
- **Unattended automation** (scheduled pickup, webhook-driven review handling) → Supporter License (one-time) or Team/Business subscription

Details: [devintern.com/pricing](https://devintern.com/pricing/)

The FSL grants no trademark rights: the DevIntern name and logo are trademarks of Daniil Pokrovsky (devintern.com) and may not be used to identify forks or derived products.

## Repository layout

| Package                               | Purpose                                                        |
| ------------------------------------- | -------------------------------------------------------------- |
| [`@getdevintern/code`](packages/code) | The `devintern` CLI: ticket → agent → self-reviewed PR         |
| [`@getdevintern/pm`](packages/pm)     | The `devpm` CLI: rough input → well-specified tickets          |
| `packages/*` (shared)                 | Agent harness, tracker clients, auth, license check, utilities |

Website and control plane live elsewhere; this repo is the tool packages.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Monorepo layout and Bun-only tooling: [AGENTS.md](AGENTS.md).

Built for teams that want agents to close tickets, not just write code.
