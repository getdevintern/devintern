# @getdevintern/pm

[![npm](https://img.shields.io/npm/v/%40getdevintern%2Fpm?label=%40getdevintern%2Fpm)](https://www.npmjs.com/package/@getdevintern/pm)
[![License](https://img.shields.io/badge/License-FSL--1.1--Apache--2.0-blue)](./LICENSE.md)
[![Docs](https://img.shields.io/badge/Docs-devintern.com-blue)](https://devintern.com/docs/pm/quick-start)

**Turn rough notes, logs, and Figma into well-specified tracker tickets — with any coding agent, on your keys.**

`devpm` grounds the draft in your codebase, then creates (or updates) issues in the tracker your team already uses.

- **Input:** freeform prompts · error logs · Figma frames · pasted requirements
- **Trackers:** Jira · Linear · GitHub Issues · Trello · Asana · Azure DevOps · markdown files
- **Agents:** Claude Code · Codex · Cursor · OpenCode · Grok Build · and others
- **BYOK:** your model keys, billed on your existing provider contract

Pair with **[`@getdevintern/code`](https://www.npmjs.com/package/@getdevintern/code)** (`devintern`) when you want those tickets implemented into self-reviewed pull requests.

## Install

```bash
bun install -g @getdevintern/pm
# or
npm install -g @getdevintern/pm
```

Requires **Node.js 20+** (Bun works too).

## Quick start

```bash
devpm init
devpm "Add password reset via email"
# or: error logs, a Figma URL (with Figma MCP), a pasted brief…
```

## Documentation

Full docs: **[devintern.com/docs/pm](https://devintern.com/docs/pm/quick-start)**

- [Quick start](https://devintern.com/docs/pm/quick-start)
- [Configuration](https://devintern.com/docs/pm/configuration)
- [Usage](https://devintern.com/docs/pm/usage)

Source monorepo: [getdevintern/devintern](https://github.com/getdevintern/devintern)

## License

[FSL-1.1-Apache-2.0](./LICENSE.md). See [pricing](https://devintern.com/pricing/) for commercial terms.
