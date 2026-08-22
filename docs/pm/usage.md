---
title: "@devintern/pm Usage Guide"
sidebarLabel: "Usage"
description: "Interactive drafting, source inputs, and posting flows for @devintern/pm."
section: "PM"
order: 3
dateModified: 2026-08-23
---

# @devintern/pm Usage Guide

[DevIntern PM](https://devintern.com/pm-desktop/) is the primary way to create and review tickets. This guide covers the CLI for terminal workflows and automation.

## Quick Capture (Desktop)

DevIntern PM Desktop can register an OS-level global shortcut so you can turn fleeting context into ticket drafts without switching apps:

- Enable it in **Settings → Quick Capture**. The default binding is `Cmd+Shift+Space` on macOS and `Ctrl+Shift+Space` on Windows/Linux, and you can record any combination.
- Invoking the shortcut focuses (or launches) the app and opens a **new** ticket workspace as the active tab — open tickets and running agents keep working in the background.
- If the clipboard holds useful text, it is prefilled and the source tab is inferred automatically (Figma URL → **Figma**, stack-trace-like text → **Error log**, anything else → **Prompt**). An empty clipboard opens an empty Prompt field with the cursor ready.
- If no project is configured yet, capturing just brings the app forward so you can finish setup first. If the shortcut is already taken by another app, Settings shows how to change the binding.

## Interactive Mode (Recommended)

The interactive mode provides a step-by-step terminal UI for creating tasks:

```bash
devpm --interactive
```

Override the agent for a single session:

```bash
devpm --interactive --harness opencode
devpm --prompt "Add login" --harness codex
```

The interactive mode will guide you through:

1. **Source type selection**: Choose between Figma URL, error log, or free-form prompt
2. **Source input**: Enter your Figma URL, error log, or requirements
3. **Custom instructions** (optional): Add additional requirements or focus areas
4. **Epic linking** (optional): Link the story to an existing epic. This step is skipped for trackers that do not support a real epic/parent hierarchy (Trello, GitHub Issues, and Markdown). Supported by Jira, Linear, Azure DevOps, and Asana.
5. **Issue type** (Jira, Azure DevOps, GitHub, Markdown only): Select Story, Task, Bug, Epic, or enter a custom type. This step is skipped for Linear, Trello, and Asana, which do not support setting an issue type.
6. **Prompt style**: Choose between PM style or Technical style
7. **Confirmation**: Review your configuration before proceeding

**Features:**

- Step-by-step guided workflow
- Keyboard navigation (Enter to confirm, ESC to go back, Ctrl+C to exit)
- Header shows active tracker and project as `Tracker/Project` (e.g., `Jira/PROJ`, `Trello/My Board`) so you always know your context
- Press `Ctrl+P` at any step to switch to a different project without restarting
- Press `Ctrl+G` at any step to switch AI agent harness (only installed CLIs are listed)
- Visual preview of your configuration
- No need to remember command-line flags
- Works great for both technical and non-technical users

## CLI Usage (For Power Users)

For power users who prefer command-line flags:

```bash
devpm --figma <url> [options]
devpm --log <text> [options]
devpm --prompt <text> [options]
```

### Source Options (one required)

- `--figma <url>`: Figma design node URL to analyze
- `--log <text>`: Error log or bug report text to analyze
- `--prompt <text>`: Free-form text describing requirements or features

### Additional Options

- `--epic, -e <key>`: Link the created story to an epic (e.g., PROJ-100). Ignored for trackers that do not support a real epic/parent hierarchy (Trello, GitHub Issues, Markdown).
- `--type, -t <type>`: Issue type (default: "Task"). Common types: Task, Story, Bug, Epic. Only applied by backends that support issue types (Jira, Azure DevOps, GitHub, Markdown); ignored by Linear, Trello, and Asana.
- `--custom, -c <text>`: Additional custom instructions for the requirements
- `--attach <path>`: Attach a local file for agent context (and upload on create when the tracker supports it). Repeatable. Supported: images, text/docs, PDF (not Office binaries such as `.docx`). Max 10 files.
- `--style, -s <type>`: Prompt style: "pm" (default) or "technical"
  - **pm**: Focuses on user stories and acceptance criteria
  - **technical**: Includes Technical Considerations section
- `--model, -m <model>`: AI model to use (e.g., "sonnet", "opus", or full model name). Overrides the `AGENT_MODEL` environment variable. The model string is harness-specific (see your harness's CLI docs); unsupported by a few harnesses (e.g. Antigravity accepts slugs from `agy models`).
- `--decompose`: Decompose the story into subtasks (default: off)
- `--confirm`: Interactively confirm each subtask before creating
- `--verbose, -v`: Enable verbose API logging for debugging (same as setting `DEVINTERN_VERBOSE=1`)
- `--help, -h`: Show help message

### Examples

**Figma designs:**

> **Note**: Figma functionality requires the Figma MCP server to be installed and configured in your AI agent (Claude Code only).

```bash
devpm --figma "https://www.figma.com/design/abc/file?node-id=123-456"
devpm --figma "https://..." --epic PROJ-100
devpm --figma "https://..." -c "Focus on accessibility"
devpm --figma "https://..." --style technical --decompose
devpm --figma "https://..." --type Task
```

**Error logs:**

```bash
devpm --log "Error: Cannot read property 'id' of undefined at line 42"
devpm --log "$(cat error.log)" --epic PROJ-200 --type Bug
devpm --log "Stack trace..." --style technical --model opus
```

**Free-form prompts:**

```bash
devpm --prompt "Add user profile settings page with theme preferences"
devpm --prompt "$(cat requirements.txt)" --epic PROJ-300
devpm --prompt "Implement OAuth login" --style technical --decompose
devpm --prompt "Refine checkout" --attach ./notes.md --attach ./shot.png
```

## Chat Bot Mode

> **Alpha:** The chat bot is experimental and may not work properly. Expect bugs and breaking changes.

Prefer creating tasks from Slack or Telegram? Run the bot daemon:

```bash
devpm connect telegram   # or: devpm connect slack
devpm serve
```

Mention the bot with a rough idea, refine the draft in a thread, and approve it to file the task. See the [Chat bot guide](./chat-bot.md) for details.

### Attachments

Attach local context files (screenshots, transcripts, roadmaps, specs) with `--attach` (CLI) or the Attach control in pm-desktop (Prompt and Error log tabs).

- The agent reads attached files while drafting (Codex also receives images via native `-i` flags; other harnesses get file paths in the prompt).
- After create, files are uploaded to the ticket when the tracker supports attachments: Jira, Linear, Azure DevOps, Asana, Trello, and Markdown. GitHub Issues has no file attachment API, so files stay draft-context only.
- Prefer `.md`, `.txt`, `.pdf`, and images. Office formats such as `.docx` are rejected because coding agents cannot reliably read them.

## How It Works

1. **Input Analysis**: Your AI agent analyzes your input:
   - **Figma designs**: Uses the Figma MCP integration to extract design specifications
   - **Error logs**: Parses error messages and stack traces to identify root causes
   - **Free-form prompts**: Interprets requirements and feature descriptions
   - **Attachments** (optional): Local files listed for the agent to open before drafting
2. **Story Creation**: Creates a comprehensive story with:
   - User story format
   - Acceptance criteria
   - Technical considerations
   - Design notes (for Figma) or reproduction steps (for bugs)
3. **Epic Linking** (optional): Links the story to the specified epic. Only runs for trackers with a real epic/parent hierarchy (Jira, Linear, Azure DevOps, Asana). Skipped for Trello, GitHub Issues, and Markdown.
4. **Attachment upload** (optional): Uploads attached files to the created issue when the tracker supports it.
5. **Task Decomposition** (optional): Breaks down the story into subtasks that are:
   - Focused on single responsibilities
   - Completable within 1-2 days
   - Properly linked to the parent story
