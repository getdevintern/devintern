# DevIntern

**Delegate the tickets. Review the pull requests.**

DevIntern wires the task tracker your team already uses to the coding agent and model you choose, on your keys, on your machines. Tickets get implemented and self-reviewed in the background; you step in when a diff is ready. Swap any piece at any time.

- **Your tracker:** Jira, Linear, Trello, Asana, Azure DevOps, GitHub Issues, or plain markdown files
- **Your coding agent:** Claude Code, Codex, Cursor, or OpenCode (swapping is one config line)
- **Your model, your keys:** whatever your agent supports, billed on your existing provider contract

Free for interactive use. No signup, no time limit. [devintern.com](https://devintern.com)

## Quick start

```bash
# Install Bun if not already installed
curl -fsSL https://bun.sh/install | bash

# Install the task automation tool
bun install -g @getdevintern/code

# In your project
devintern init          # creates .devintern-code/ config
devintern PROJ-123      # turn a ticket into a pull request
```

Full setup guides for every tracker and agent: [devintern.com/docs](https://devintern.com/docs/code/quick-start/)

## What's in this repository

| Package | What it does |
| ------- | ------------ |
| [`@getdevintern/code`](packages/code) | The `devintern` tool: picks up tracker tickets, runs your coding agent, opens self-reviewed PRs, and (with unattended automation) turns review comments into commits |
| [`@getdevintern/pm`](packages/pm) | The `devpm` tool: turns rough input (prompts, logs, Figma frames) into well-specified, codebase-grounded tickets |
| `packages/*` (shared) | Source-only workspace packages: agent harness abstraction, tracker clients, auth, license check, utilities |

The devintern.com website and its server code live in a separate repository.

## How it holds up unattended

- **Feasibility gate**: vague tickets get flagged back to the tracker with questions instead of becoming a confidently wrong PR
- **Self-review loop**: the agent reviews and fixes its own diff before any human sees it
- **Review comments become commits** (with unattended automation): reviewer feedback is addressed on the same branch, with replies
- **Survives real life**: persistent queue, crash recovery, provider rate-limit detection with pause and resume

## Contributing

See [AGENTS.md](AGENTS.md) for the monorepo layout, tooling (Bun only), and per-package commands. Pre-commit hooks run format, lint, and typecheck via lefthook.

## License and pricing

The source is available under the [Functional Source License, Version 1.1, with Apache 2.0 Future License](LICENSE.md) (FSL-1.1-Apache-2.0). You can read it, audit it, self-build, and self-host; each release converts to Apache-2.0 two years after publication.

Interactive use is free forever. Unattended automation (scheduled ticket pickup and webhook-driven review handling) requires a license: a one-time Supporter License for solo use or a Team/Business subscription. See [devintern.com/pricing](https://devintern.com/pricing/).

The FSL grants no trademark rights: the DevIntern name and logo are trademarks of Daniil Pokrovsky (devintern.com) and may not be used to identify forks or derived products.
