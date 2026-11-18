---
title: "DevIntern PM Configuration"
sidebarLabel: "Configuration"
description: "Environment variables, tracker credentials, and defaults for @devintern/pm."
section: "Create Tasks"
order: 2
dateModified: 2026-11-18
---

# DevIntern PM Configuration

DevIntern PM reads per-project settings from `.devintern-pm/.env`. Run `devpm init` in your project for a guided setup: it asks which tracker you use, links to the token page, validates the connection, and writes the file (and adds it to `.gitignore`). For CI or hand editing, `devpm init --yes` writes a template instead.

devpm looks for `.devintern-pm/.env` in the current directory and its parents, up to the nearest `.git` directory or your home directory, so you can run it from any subdirectory. DevIntern PM is free under the FSL license and needs no license key.

## Select a Backend

Set `TASK_TRACKER` (default `jira`) and the variables for that tracker only; other trackers' variables are ignored.

| `TASK_TRACKER` | Required variables                                          | Optional                                                                    | Guide                                       |
| -------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| `jira`         | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_DEFAULT_PROJECT_KEY` |                                                             | [Jira](./jira-integration.md)               |
| `linear`       | `LINEAR_API_KEY`                                            | `LINEAR_DEFAULT_TEAM_KEY`                                                   | [Linear](./linear-integration.md)           |
| `trello`       | `TRELLO_API_TOKEN`                                          | `TRELLO_DEFAULT_BOARD_ID`, `TRELLO_DEFAULT_LIST_NAME`, `TRELLO_API_KEY`     | [Trello](./trello-integration.md)           |
| `azure-devops` | `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_PROJECT` |                                                                          | [Azure DevOps](./azure-devops-integration.md) |
| `asana`        | `ASANA_API_TOKEN`                                           | `ASANA_DEFAULT_PROJECT_GID`                                                 | [Asana](./asana-integration.md)             |
| `github`       | `GITHUB_TOKEN`, `GITHUB_REPO`                               |                                                                             | [GitHub Issues](./github-integration.md)    |
| `gitlab`       | `GITLAB_TOKEN`, `GITLAB_PROJECT`                            | `GITLAB_BASE_URL` (self-hosted)                                             | [GitLab](./gitlab-integration.md)           |
| `markdown`     | none                                                        | `MARKDOWN_TASKS_DIR` (default `.devintern-pm/tasks`, relative to the project root) |                                      |

```bash
# .devintern-pm/.env
TASK_TRACKER=linear
LINEAR_API_KEY=lin_api_xxxxxxxxxxxx
```

With `markdown`, tasks are written as local Markdown files instead of being sent to a tracker.

## Agent Harness

DevIntern PM drafts stories by running an AI agent CLI on your machine.

| Variable / flag                  | Default                    | Purpose                                                                                     |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `AGENT_HARNESS` / `--harness`    | `claude-code`              | Agent to run. A comma-separated list enables failover (below).                               |
| `AGENT_MODEL` / `--model`, `-m`  | harness default            | Model string, in the harness's own format (e.g. `sonnet`, a Codex model ID, an `agy models` slug). |
| `AGENT_EFFORT` / `--effort`      | unset (no flag emitted)    | Reasoning effort: `low`, `medium`, or `high`.                                                |
| `AGENT_CLI_PATH`                 | found on `PATH`            | Path to the agent binary, only if it is not on `PATH` or has a non-standard name.            |
| `<HARNESS>_CLI_PATH`, `<HARNESS>_MODEL` |                     | Per-harness path and model (e.g. `OPENCODE_CLI_PATH`, `GROK_MODEL`), used when `AGENT_*` doesn't apply. |

Flags override the environment for a single run. In interactive mode, `Ctrl+G` switches among installed agents. In the desktop app, **Settings → Agent model** and **Settings → Agent effort** save the same values to `.devintern-pm/.env`.

The binary is resolved from `AGENT_CLI_PATH`, then `<HARNESS>_CLI_PATH`, then the harness's default command on `PATH`.

**Supported harnesses:**

| `AGENT_HARNESS`               | Binary         | Notes                                                                                                     |
| ----------------------------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| `claude-code` (alias `claude`) | `claude`      | Required for Figma sources (with the Figma MCP server).                                                   |
| `opencode`                    | `opencode`     | On OpenCode v2, effort applies only when a model is set.                                                   |
| `codex`                       | `codex`        |                                                                                                           |
| `cursor`                      | `cursor-agent` | Enable the CLI in Cursor's settings.                                                                       |
| `grok`                        | `grok`         | Grok Build, from [x.ai/cli](https://x.ai/cli). Log in, or set `XAI_API_KEY`.                               |
| `deepseek`                    | `reasonix`     | `npm i -g reasonix`, then set `DEEPSEEK_API_KEY` or run `reasonix setup`.                                  |
| `antigravity` (alias `agy`)   | `agy`          | [Install](https://antigravity.google/docs/cli/install); `ANTIGRAVITY_TOKEN` for CI. `gemini` still works but is deprecated. |
| `muse` (alias `muse-code`)    | `muse`         | Muse Code 1.4.9+. Default model `muse-spark-1.2`. Set `META_API_KEY` for unattended runs (required on macOS under `nono`). See [Muse auth](https://dev.meta.ai/docs/muse-code/auth). |
| `cline`, `goose`, `kimi`      | same as id     |                                                                                                           |
| `kilo-code`                   | `kilo`         |                                                                                                           |
| `qwen`                        | `qwen`         | Model can also be set in `~/.qwen/settings.json`.                                                          |
| `pi`                          | `pi`           | Effort applies only when a model is set.                                                                   |

A few harnesses have no model flag and ignore `AGENT_MODEL`. Harnesses without a reasoning-effort option ignore `AGENT_EFFORT` with a one-line warning.

### Failover on usage limits

List several harnesses in priority order to fall back when one hits its usage limit:

```bash
AGENT_HARNESS=opencode,grok
# GROK_MODEL=grok-4.7   # optional model for the fallback
```

- devpm prints one line naming the limited harness and the next one, then retries the same request there. Other failures do not fail over.
- Unknown or uninstalled entries are skipped with a warning. If every entry is limited, the run fails with a list of them.
- `AGENT_MODEL`, `AGENT_EFFORT`, and `AGENT_CLI_PATH` apply to the first entry only; fallbacks use their `<HARNESS>_MODEL` / `<HARNESS>_CLI_PATH` or defaults.
- A successful fallback is used for the rest of that run; the next run starts from the first entry again.
- `--harness` or picking an agent in the interactive picker turns failover off. In the desktop app, picking an agent moves it to the front of the list (`opencode,grok` → `grok,opencode`).

## Other Settings

| Variable                                                  | Default | Purpose                                                                                       |
| --------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `DEVINTERN_VERBOSE=1` (or `--verbose`, `-v`)              | off     | Log every API request, status, and retry. Useful for auth and network problems.               |
| `SENTRY_DISABLED=1`                                       | off     | Stop sending error reports (see below).                                                       |
| `DEVPM_NO_UPDATE=1` / `DEVINTERN_NO_UPDATE=1` (or `--no-update`) | off | Skip the daily update check.                                                            |
| `DEVPM_AUTO_UPDATE=1` / `DEVINTERN_AUTO_UPDATE=1`         | off     | Install updates without prompting, including in CI.                                           |
| `AGENT_SPAWN_ENOENT_RETRIES`                              | `5`     | Retries when the agent binary is briefly missing during its own auto-update.                  |
| `AGENT_SPAWN_ENOENT_BACKOFF_MS`                           | `1000`  | First retry delay for the above (doubles each attempt).                                       |

### Proxy

Set `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` (or lowercase forms) in your **shell**, not in `.devintern-pm/.env`, which loads too late. On Node.js 24.14+ or 25.4+ devpm enables proxy support automatically; on older Node, run with `NODE_USE_ENV_PROXY=1` or upgrade. Network errors print the underlying cause (e.g. `ECONNREFUSED`), never the proxy URL.

### Error reporting

The CLI and desktop app send crash and error reports to DevIntern's Sentry. Prompts, ticket text, project paths, `.env` contents, and credentials are never sent. Opt out with `SENTRY_DISABLED=1` in your shell or `.devintern-pm/.env`; in the desktop app, turning off **Settings → Anonymous analytics** disables both analytics and error reporting.

### Updates

A globally installed `devpm` checks npm for a new version at most once a day. In a terminal it asks `Update? (Y/n)`; in CI and scripts it only prints a notice. Local and linked installs are never updated. To upgrade now: `npm install -g @getdevintern/pm@latest` (or `bun install -g`). Delete `~/.devintern/update-check.json` to force a fresh check.

## Troubleshooting

**"Missing required environment variables"**: run `devpm init`, and check you set the variables for your `TASK_TRACKER` (see the [table above](#select-a-backend)).

**"API error (401)" or "(403)"**: the token is wrong, revoked, or lacks permissions. See the Troubleshooting section of your tracker's guide: [Jira](./jira-integration.md#troubleshooting), [Linear](./linear-integration.md#troubleshooting), [Trello](./trello-integration.md#troubleshooting), [Azure DevOps](./azure-devops-integration.md#troubleshooting), [Asana](./asana-integration.md#troubleshooting), [GitHub](./github-integration.md#troubleshooting), [GitLab](./gitlab-integration.md#troubleshooting).

**"Unknown agent harness"**: check the spelling of `AGENT_HARNESS` against the list in the error, and make sure the CLI is installed and on `PATH` (or set `AGENT_CLI_PATH`).

**"Failed to parse story from agent output"**: devpm already repairs common output problems and retries once. If it still fails, the raw output is saved to `/tmp/devpm-<step>-<timestamp>.log`. Persistent failures usually go away with a different harness or model.
