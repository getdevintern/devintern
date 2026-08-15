# @getdevintern/code

[![npm](https://img.shields.io/npm/v/%40getdevintern%2Fcode?label=%40getdevintern%2Fcode)](https://www.npmjs.com/package/@getdevintern/code)
[![License](https://img.shields.io/badge/License-FSL--1.1--Apache--2.0-blue)](./LICENSE.md)
[![Docs](https://img.shields.io/badge/Docs-devintern.com-blue)](https://devintern.com/docs/code/quick-start)

**Turn tracker tickets into pull requests with any coding agent — on your keys, self-hosted.**

`devintern` watches your issue tracker (or a local markdown file), runs Claude Code / Codex / Cursor / OpenCode / others, and opens a ready-to-review PR. Interactive use is free forever.

- **Trackers:** Jira · Linear · GitHub Issues · Trello · Asana · Azure DevOps · markdown files
- **Agents:** Claude Code · Codex · Cursor · OpenCode · Grok Build · and others
- **BYOK:** your model keys, billed on your existing provider contract

**Also useful:** feasibility questions go back on the ticket instead of a wrong PR; the agent self-reviews its diff before you see it; unattended pickup is available when you want it.

Pair with **[`@getdevintern/pm`](https://www.npmjs.com/package/@getdevintern/pm)** (`devpm`) to turn rough notes, logs, or Figma into well-specified tickets first.

## Install

```bash
bun install -g @getdevintern/code
# or
npm install -g @getdevintern/code
```

## Quick start

```bash
# Zero tracker credentials: local markdown task → PR
devintern ./tasks/feature-spec.md --create-pr

# Or configure a real tracker
devintern init
devintern PROJ-123 --create-pr
```

## Documentation

Full docs: **[devintern.com/docs/code](https://devintern.com/docs/code/quick-start)**

- [Quick start](https://devintern.com/docs/code/quick-start)
- [Configuration](https://devintern.com/docs/code/configuration)
- [Usage](https://devintern.com/docs/code/usage)
- [Markdown file tasks](https://devintern.com/docs/code/markdown-tasks)
- [Worker / unattended automation](https://devintern.com/docs/code/worker)
- [GitHub integration](https://devintern.com/docs/code/github-integration)

Source monorepo: [getdevintern/devintern](https://github.com/getdevintern/devintern)

## Extensible pipeline

The task workflow is an ordered pipeline of pluggable steps (default: `implement` → `commit` → `auto-review` → `finalize`). Customize it in `.devintern-code/settings.json`:

```json
{
  "pipeline": {
    "plugins": ["./.devintern-code/steps/my-step.ts"],
    "steps": [
      { "use": "implement" },
      { "use": "commit" },
      { "use": "verify", "onFail": "loopback", "minSeverity": "high" },
      { "use": "my-step" },
      { "use": "finalize" }
    ]
  }
}
```

- **Declarative (no code):** add the built-in `verify` step — an agent-backed requirements checker that feeds findings back to the implementer (`onFail: "loopback"`), halts, or warns. Multiple instances with different prompts are supported.
- **Code plugins:** a plugin module default-exports a `StepDefinition` (typed API from `@getdevintern/code/pipeline`) and is loaded at startup from a file path or npm package name — no rebuild required.

See the [Configuration guide](https://devintern.com/docs/code/configuration) for details.

## License

[FSL-1.1-Apache-2.0](./LICENSE.md). Interactive use free forever; unattended automation requires a license — see [pricing](https://devintern.com/pricing/).
