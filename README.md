# DevIntern

**Turn tracker tickets into pull requests with any coding agent — on your keys, self-hosted.**

[![License](https://img.shields.io/badge/License-FSL--1.1--Apache--2.0-blue)](LICENSE.md)
[![Website](https://img.shields.io/badge/Website-devintern.com-blue)](https://devintern.com)
[![npm](https://img.shields.io/npm/v/%40getdevintern%2Fcode?label=%40getdevintern%2Fcode)](https://www.npmjs.com/package/@getdevintern/code)
[![Stars](https://img.shields.io/github/stars/getdevintern/devintern?style=social)](https://github.com/getdevintern/devintern)

<!-- Drop a short demo GIF here when available (ticket → agent → PR). Host at docs/demo.gif and allowlist it in publish/sync.sh.
<p align="center">
  <img src="docs/demo.gif" width="820" alt="DevIntern demo: ticket becomes a pull request">
</p>
-->

DevIntern connects the tracker your team already uses to the coding agent and model you choose. Tickets get implemented and self-reviewed in the background; you step in when a clean diff is ready. Swap any piece at any time.

- **Your tracker:** Jira · Linear · GitHub Issues · Trello · Asana · Azure DevOps · plain markdown files
- **Your agent:** Claude Code · Codex · Cursor · OpenCode (one config line to switch)
- **Your keys:** BYOK — billed on your existing provider contract
- **Interactive use is free forever** — no signup, no time limit

→ [Live docs & full setup](https://devintern.com/docs/code/quick-start/)

## Quick start

```bash
# Requires Bun
curl -fsSL https://bun.sh/install | bash
bun install -g @getdevintern/code

# Zero tracker credentials: pass a local markdown task
devintern ./tasks/feature-spec.md --create-pr
```

That is the full loop: markdown task → agent run → pull request. No Jira/Linear account required for the markdown path.

With a real tracker (after `devintern init`):

```bash
devintern init          # interactive setup for your tracker + agent
devintern PROJ-123 --create-pr
```

Full tracker and agent guides: [devintern.com/docs](https://devintern.com/docs/code/quick-start/)

## Why teams use it

| Capability | What it does |
| --- | --- |
| **Feasibility gate** | Vague tickets get questions back on the tracker instead of a confidently wrong PR |
| **Self-review loop** | The agent reviews and fixes its own diff before a human sees it |
| **Unattended automation** | Scheduled pickup; review comments become commits on the same branch |
| **Real-world resilience** | Persistent queue, crash recovery, rate-limit pause/resume |

## Packages in this repository

| Package | Purpose |
| --- | --- |
| [`@getdevintern/code`](packages/code) | The `devintern` CLI: ticket → agent → self-reviewed PR |
| [`@getdevintern/pm`](packages/pm) | The `devpm` CLI: rough notes, logs, or Figma frames → well-specified tickets |
| `packages/*` (shared) | Source-only workspace packages: agent harness, tracker clients, auth, license check, utilities |

The website and control plane live elsewhere; this repository is the tool packages only.

## License and pricing

Source is under the [Functional Source License, Version 1.1, with Apache 2.0 Future License](LICENSE.md) (FSL-1.1-Apache-2.0). You can read it, audit it, self-build, and self-host. Each release converts to Apache-2.0 two years after publication.

- **Interactive use** → free forever
- **Unattended automation** (scheduled pickup, webhook-driven review handling) → Supporter License (one-time) or Team/Business subscription

Details: [devintern.com/pricing](https://devintern.com/pricing/)

The FSL grants no trademark rights: the DevIntern name and logo are trademarks of Daniil Pokrovsky (devintern.com) and may not be used to identify forks or derived products.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how PRs are handled during the private→public sync transition, and [AGENTS.md](AGENTS.md) for monorepo layout, tooling (Bun only), and per-package commands. Pre-commit hooks run format, lint, and typecheck via lefthook.

Built for teams that want agents to close tickets, not just write code.
