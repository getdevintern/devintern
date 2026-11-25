---
title: "DevIntern PM Usage Guide"
sidebarLabel: "Using DevIntern PM"
description: "Interactive drafting, source inputs, and posting flows for @devintern/pm."
section: "Create Tasks"
order: 1
dateModified: 2026-11-18
---

# DevIntern PM Usage Guide

[DevIntern PM Desktop](https://devintern.com/pm-desktop/) is the main way to create and review tickets. This guide covers its Quick Capture shortcut and the `devpm` CLI for terminal workflows and automation.

## Quick Capture (Desktop)

Turn on **Settings → Quick Capture** to get a global shortcut (default `Cmd+Alt+Q` on macOS, `Ctrl+Alt+Q` on Windows/Linux; you can record your own). The shortcut brings the app forward and opens a new ticket tab, prefilled from the clipboard: a Figma URL opens the **Figma** tab, a stack trace opens **Error log**, and other text opens **Prompt**. Other tickets and running agents keep working in the background.

## Interactive Mode

```bash
devpm --interactive
devpm --interactive --harness opencode   # use a different agent for this session
```

The terminal UI walks you through:

1. **Source type**: Figma URL, error log, or free-form prompt
2. **Source input**: paste the URL, log, or requirements
3. **Custom instructions** (optional)
4. **Epic linking** (optional): Jira, Linear, Azure DevOps, and Asana only
5. **Issue type**: Jira, Azure DevOps, GitHub, GitLab, and Markdown only. Task is the default.
6. **Prompt style**: PM or Technical
7. **Confirmation**

Keys: `Enter` confirms, `Esc` goes back, `Ctrl+C` exits, `Ctrl+P` switches project, `Ctrl+G` switches agent (installed ones only). The header shows the active `Tracker/Project`, e.g. `Jira/PROJ`.

## CLI Mode

Pass one source and any options:

```bash
devpm --figma <url> [options]
devpm --log <text> [options]
devpm --prompt <text> [options]
```

| Option                | Description                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--figma <url>`       | Figma design node URL. Needs Claude Code with the [Figma MCP server](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/). |
| `--log <text>`        | Error log or bug report.                                                                                                                              |
| `--prompt <text>`     | Free-form requirements.                                                                                                                               |
| `--epic, -e <key>`    | Link to an epic (e.g. `PROJ-100`). Ignored by Trello, GitHub, GitLab, and Markdown.                                                                   |
| `--type, -t <type>`   | Issue type, default `Task` (e.g. Story, Bug, Epic). Ignored by Linear, Trello, and Asana.                                                             |
| `--custom, -c <text>` | Extra instructions for the draft.                                                                                                                     |
| `--attach <path>`     | Attach a local file (repeatable, max 10). See [Attachments](#attachments).                                                                            |
| `--style, -s <style>` | `pm` (default: user story, Given/When/Then criteria, non-goals, success metrics) or `technical` (adds Technical Considerations).                      |
| `--harness <name>`    | Agent to run for this command. See [Configuration](./configuration.md#agent-harness).                                                                 |
| `--model, -m <model>` | Model for this run (overrides `AGENT_MODEL`); format depends on the harness.                                                                          |
| `--effort <level>`    | `low`, `medium`, or `high` (overrides `AGENT_EFFORT`).                                                                                                |
| `--decompose`         | Also break the story into subtasks.                                                                                                                   |
| `--confirm`           | Confirm each subtask before it is created.                                                                                                            |
| `--verbose, -v`       | Log API calls (same as `DEVINTERN_VERBOSE=1`).                                                                                                        |
| `--no-update`         | Skip the update check for this run.                                                                                                                   |
| `--help, -h`          | Show help.                                                                                                                                            |

### Examples

```bash
devpm --figma "https://www.figma.com/design/abc/file?node-id=123-456" --epic PROJ-100
devpm --log "$(cat error.log)" --type Bug --style technical
devpm --prompt "Implement OAuth login" --decompose --confirm
devpm --prompt "Refine checkout" --attach ./notes.md --attach ./shot.png
```

## Attachments

Attach screenshots, transcripts, or specs with `--attach`, or the **Attach** control on the desktop app's Prompt and Error log tabs. The agent reads them while drafting. After the ticket is created, files are uploaded to it on Jira, Linear, Azure DevOps, Asana, Trello, and Markdown; GitHub and GitLab keep them as draft context only.

Use images, `.md`, `.txt`, or `.pdf`. Office files such as `.docx` are rejected because agents can't read them reliably.

## What Gets Created

Each draft includes a user story, Given/When/Then acceptance criteria with edge cases, non-goals, success metrics, technical considerations, and design notes (Figma) or reproduction steps (bugs). Drafts describe observable behavior rather than vague words like "fast" or "intuitive". With `--decompose`, subtasks are scoped to a single responsibility, about 1–2 days each, and linked to the story. See your [tracker's guide](./configuration.md#select-a-backend) for how each item maps to tracker objects.

When `devpm` runs inside a DevIntern Code agent run (for example an automation that files tickets), every ticket and subtask it creates is linked to that run and listed under **Spawned work** on the run's dashboard page. Nothing to configure: DevIntern sets `DEVINTERN_RUN_OUTPUTS` for the run. If the link can't be recorded, `devpm` prints a warning and the ticket is still created. See [Run lineage](../code/delegation.md#run-lineage).

## Chat Bot (Alpha)

To draft tasks from Slack or Telegram instead, run `devpm connect slack` (or `telegram`) and then `devpm serve`. See the [Chat bot guide](./chat-bot.md).
