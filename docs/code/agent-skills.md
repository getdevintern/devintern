---
title: "DevIntern Agent Skills"
sidebarLabel: "Agent Skills"
description: "Use when you want Codex or Claude Code to set up a DevIntern worker, configure a workspace, delegate tasks, or file a bug report."
section: "Automation"
order: 1
dateModified: 2026-11-12
tags: ["skills", "codex", "claude-code", "worker"]
---

# DevIntern Agent Skills

DevIntern ships four skills that teach your coding agent how to operate a DevIntern worker. Use them to set up DevIntern from a chat, maintain a workspace, hand agreed implementation work to a worker that can return a pull request, or file a useful bug report.

## Install

With [Bun](https://bun.sh/) installed, run this from the project where you use your coding agent:

```bash
bunx skills add getdevintern/devintern \
  --skill devintern-setup devintern-workspace devintern-delegate devintern-report --agent codex
```

For Claude Code, replace `--agent codex` with `--agent claude-code`. To install for both, use `--agent codex claude-code`. Add `--global` for user-wide availability; otherwise installation is scoped to the current project. Select fewer names after `--skill` to install only what you need.

To list the skills available from the public repository without installing them:

```bash
bunx skills add getdevintern/devintern --list
```

The skills live in the repository's [plugin skills directory](https://github.com/getdevintern/devintern/tree/main/plugins/devintern/skills). The [Skills CLI](https://github.com/vercel-labs/skills) installs their instructions and supporting references for the selected agent.

### Install as a Claude Code plugin

The repository is also a Claude Code plugin marketplace. Inside Claude Code, run:

```text
/plugin marketplace add getdevintern/devintern
/plugin install devintern@devintern
```

From a shell, use `claude plugin marketplace add getdevintern/devintern` and `claude plugin install devintern@devintern`. The plugin installs all four skills, namespaced as `devintern:devintern-setup`, `devintern:devintern-workspace`, `devintern:devintern-delegate`, and `devintern:devintern-report`. Run `/plugin marketplace update devintern` to pick up new skill versions.

For a smaller download, add the marketplace from a shell with a sparse checkout of only the plugin files, then install as above:

```bash
claude plugin marketplace add getdevintern/devintern --sparse .claude-plugin plugins
```

#### Share with your team

To offer the plugin to everyone who works in a repository, commit this `.claude/settings.json` at the repository root:

```json
{
  "extraKnownMarketplaces": {
    "devintern": {
      "source": {
        "source": "github",
        "repo": "getdevintern/devintern",
        "sparsePaths": [".claude-plugin", "plugins"]
      }
    }
  },
  "enabledPlugins": {
    "devintern@devintern": true
  }
}
```

Running `claude plugin marketplace add getdevintern/devintern --scope project --sparse .claude-plugin plugins` and then `claude plugin install devintern@devintern --scope project` from the repository root writes the same file.

After a teammate accepts the workspace trust dialog for the repository, Claude Code registers the DevIntern marketplace for them. Enabling the plugin in project settings does not download it, so each teammate runs `claude plugin install devintern@devintern --scope project` once. For Codex and other agents, use `bunx skills add` as described above.

## Choose a skill

| Skill                                                                                                                   | When to use it                                                                                           | Example prompt                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [devintern-setup](https://github.com/getdevintern/devintern/tree/main/plugins/devintern/skills/devintern-setup)         | First-time installation, account connections, authorization, and worker activation.                      | "Set up a DevIntern worker for this repo using Codex and GitHub Issues. Help me connect the accounts and verify it is ready."                             |
| [devintern-workspace](https://github.com/getdevintern/devintern/tree/main/plugins/devintern/skills/devintern-workspace) | Existing workspace repositories, teams, routing, schedules, monitors, pipelines, and runtime policy.     | "Add a weekly dependency-health automation for web-app on Mondays at 09:00 in the worker host's timezone, opening a PR for at most one verified upgrade." |
| [devintern-delegate](https://github.com/getdevintern/devintern/tree/main/plugins/devintern/skills/devintern-delegate)   | Dispatch agreed implementation work to a registered worker repository without creating a tracker ticket. | "Delegate the checkout retry fix we agreed on to the backend repo through DevIntern. Include the acceptance criteria and return the task ID."             |
| [devintern-report](https://github.com/getdevintern/devintern/tree/main/plugins/devintern/skills/devintern-report)       | Diagnose a DevIntern failure and file a redacted bug report without leaking secrets or task content.     | "The worker crashed after switching harnesses. Check whether this is a DevIntern bug and, if so, file a report with the last run and the log."            |

Skills can be installed independently. Each includes instructions for its scope and links to the relevant DevIntern documentation.

## Prerequisites

Installing a skill gives your agent instructions. It does not install DevIntern, connect accounts, start a service, or grant automation access.

- **Setup:** the setup skill helps check or install Bun, Git, DevIntern Code, and your chosen coding agent. You still need to authorize source-control, tracker, and agent access on the worker host. See the [quick start](quick-start.md) and [relay guide](relay.md).
- **Workspace configuration:** an existing workspace is required. The skill preserves existing settings and checks whether a change needs a live reload or restart. See [workspaces](workspaces.md).
- **Delegation:** configure the target repository in the workspace and run a worker with automation access through the Worker Pilot or a paid license. The installed CLI must support `devintern worker add`, including the flags used by the skill; check `devintern worker add --help`. The agent checks repository identity and submits a self-contained brief. See [Delegate Tasks to the Worker](delegation.md).
- **Bug reports:** the installed CLI must support `devintern report`; check `devintern report --help`. Signed-in reports are preferred, while anonymous reports need a contact email. The skill previews the redacted payload and asks before submitting. See [reporting bugs](reporting-bugs.md).

The skills operate DevIntern Code. DevIntern PM and PM Desktop setup use their own [quick start](../pm/quick-start.md).

## Keep skills current

From the project where you installed the skills, update them with:

```bash
bunx skills update devintern-setup devintern-workspace devintern-delegate devintern-report
```

Name only the skills you installed. For a global installation, add `--global`. Skills and the DevIntern CLI update separately; updating one does not update the other. Check installed command help when a skill refers to a command or flag your CLI does not recognize.
