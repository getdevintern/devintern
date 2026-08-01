# @getdevintern/pm

**Turn rough notes, logs, and Figma into well-specified tracker tickets — with any coding agent, on your keys.**

`devpm` grounds the draft in your codebase, then creates (or updates) issues in the tracker your team already uses. Pair with `@getdevintern/code` when you want those tickets implemented into PRs.

- **Input:** freeform prompts · error logs · Figma frames · pasted requirements
- **Trackers:** Jira · Linear · GitHub Issues · Trello · Asana · Azure DevOps · markdown files
- **Agents:** Claude Code · Codex · Cursor · OpenCode · Grok Build · and others
- **BYOK:** your model keys, billed on your existing provider contract

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
