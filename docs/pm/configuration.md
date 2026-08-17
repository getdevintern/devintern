---
title: "@devintern/pm Configuration"
sidebarLabel: "Configuration"
description: "Environment variables, tracker credentials, and defaults for @devintern/pm."
section: "PM"
order: 2
dateModified: 2026-08-08
---

# @devintern/pm Configuration

@devintern/pm uses per-project configuration stored in `.devintern-pm/.env` in your project directory. Run `devpm init` in a terminal for a guided setup: it asks which tracker you use, links to each provider's token creation page, validates the connection, and writes the file for you. Prefer editing by hand (or setting up in CI)? Run `devpm init --yes` to write the configuration template instead, then fill in values for your selected backend as described below.

## Select a Backend

Set `TASK_TRACKER` to choose your PM tool. Defaults to `jira` if not specified.

Supported backends: `jira`, `linear`, `trello`, `azure-devops`, `asana`, `github`, `markdown`

```bash
TASK_TRACKER=jira
```

## Backend-Specific Configuration

Only configure the section that matches your `TASK_TRACKER`. Other backend variables are ignored.

### Jira

```bash
TASK_TRACKER=jira
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-api-token
JIRA_DEFAULT_PROJECT_KEY=PROJ
```

Create an API token at [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Use the Atlassian account email that owns the token for `JIRA_EMAIL`.

**Project key**: the short prefix on issue keys (e.g. `PROJ` in `PROJ-123`). Find it in any issue URL or under **Project settings → Details → Key**.

See the [Jira Integration guide](./jira-integration.md) for step-by-step setup and troubleshooting.

### Linear

```bash
TASK_TRACKER=linear
LINEAR_API_KEY=lin_api_xxxxxxxxxxxx
# LINEAR_DEFAULT_TEAM_KEY=ENG  # optional, first team if omitted
```

Create a **Personal API key** at [https://linear.app/settings/api](https://linear.app/settings/api) (Settings → API → Personal API keys). Keys start with `lin_api_` and cannot be viewed again after creation.

**Team key**: the short prefix on issue identifiers (e.g. `ENG` in `ENG-42`). Find it under team Settings → Key, or pick a team in interactive mode (Ctrl+P).

See the [Linear Integration guide](./linear-integration.md) for step-by-step setup and troubleshooting.

### Trello

`TRELLO_API_TOKEN` is the only required variable: @devintern/pm includes a bundled Power-Up key so you don't need to register your own app.

```bash
TASK_TRACKER=trello
TRELLO_API_TOKEN=your-api-token        # required
# TRELLO_API_KEY=your-api-key          # optional: use your own Power-Up
# TRELLO_DEFAULT_BOARD_ID=abc123       # optional, first board if omitted
# TRELLO_DEFAULT_LIST_NAME="To Do"     # optional, first list if omitted
```

See the [Trello Integration guide](./trello-integration.md) for step-by-step setup.

### Azure DevOps

```bash
TASK_TRACKER=azure-devops
AZURE_DEVOPS_ORG=your-organization
AZURE_DEVOPS_PAT=your-personal-access-token
AZURE_DEVOPS_PROJECT=YourProject
```

All three variables are **required**. Use the organization slug from your URL (`https://dev.azure.com/your-org/...` → `your-org`), not the full URL.

Create a **Personal Access Token** at `https://dev.azure.com/your-org/_usersSettings/tokens` with **Work Items (Read & write)** and **Project and Team (Read)** scopes.

**Project name**: must match exactly as shown in Azure DevOps (from the URL path or project picker). Work item types depend on your process template (Agile, Scrum, Basic, etc.).

See the [Azure DevOps Integration guide](./azure-devops-integration.md) for step-by-step setup and troubleshooting.

### Asana

```bash
TASK_TRACKER=asana
ASANA_API_TOKEN=your-asana-pat
# ASANA_DEFAULT_PROJECT_GID=2222222222222222  # optional, first project if omitted
```

Create a token at [https://app.asana.com/0/developer-console](https://app.asana.com/0/developer-console).

**Project GID**: the numeric ID after `/project/` in your project URL (e.g. `https://app.asana.com/1/…/project/2222222222222222/list/…` → `2222222222222222`).

See the [Asana Integration guide](./asana-integration.md) for step-by-step setup and troubleshooting.

### GitHub Issues

@devintern/pm creates issues in a repository via the GitHub REST API.

```bash
TASK_TRACKER=github
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_REPO=your-username-or-org/your-repo
```

**Personal Access Token**: both types work; fine-grained is recommended:

- **Fine-grained:** [Generate token](https://github.com/settings/personal-access-tokens/new) with **Issues: Read and write** on the target repo
- **Classic:** [Generate token](https://github.com/settings/tokens/new) with `repo` scope (private repos) or `public_repo` (public repos only)

See the [GitHub Issues Integration guide](./github-integration.md) for step-by-step setup, label mapping, and troubleshooting.

### Markdown (local file export)

```bash
TASK_TRACKER=markdown
# MARKDOWN_TASKS_DIR=.devintern-pm/tasks  # optional, defaults to .devintern-pm/tasks
```

Tasks are written as Markdown files under this directory (relative to the project root).

## Agent Harness

Configure which AI agent CLI runs when generating stories and tasks:

```bash
# Which harness to use (default: claude-code)
AGENT_HARNESS=claude-code

# Optional: path to the agent executable (leave unset in most cases)
# AGENT_CLI_PATH=/custom/path/to/claude
```

In most cases you only need `AGENT_HARNESS`. By default each harness uses its standard command (for example `claude` for `claude-code`), and devintern locates it on your `PATH` automatically. Set `AGENT_CLI_PATH` only when the CLI is not on your `PATH` or uses a non-standard name.

You can also override the harness for a single run with `--harness <name>` (CLI or interactive). In interactive mode, `Ctrl+G` opens a picker of installed agents; an explicit selection uses that harness's own path env vars and does not keep a previous `AGENT_CLI_PATH`.

**Resolution order for the executable path:**

1. `AGENT_CLI_PATH`
2. Harness-specific env var (e.g. `OPENCODE_CLI_PATH` when `AGENT_HARNESS=opencode`)
3. Harness default command, located on your `PATH` (e.g. `claude`)

Common `AGENT_HARNESS` values include `claude-code`, `opencode`, `codex`, `cursor`, `grok`, `deepseek`, `antigravity`, `cline`, `goose`, `kilo-code`, `kimi`, `muse`, and `qwen`. If you do need to set a path explicitly, run `which` for the harness binary (`claude`, `opencode`, `codex`, `cursor-agent`, `grok`, `reasonix`, `agy`, `cline`, `goose`, `kilo`, `kimi`, `muse`, or `qwen`).

**Cursor note:** The Cursor harness uses Cursor's headless `cursor-agent` CLI (not a command named `cursor`). Cursor also installs an `agent` alias, but devpm looks for `cursor-agent` because other tools use the `agent` name too. Install Cursor and enable the CLI from Cursor's settings, then set `AGENT_HARNESS=cursor`.

**Grok note:** Product name is Grok Build; the CLI binary is `grok`. Install from [x.ai/cli](https://x.ai/cli), authenticate (browser login or `XAI_API_KEY`), then set `AGENT_HARNESS=grok`.

**DeepSeek note:** Harness id is `deepseek`; the CLI binary is `reasonix` (DeepSeek-Reasonix). Install with `npm i -g reasonix`, set `DEEPSEEK_API_KEY` (or run `reasonix setup`), then set `AGENT_HARNESS=deepseek`.

**Antigravity note:** Harness id is `antigravity` (alias `agy`); the CLI binary is `agy`. Google retired consumer Gemini CLI on 2026-06-18 in favor of Antigravity CLI. Install from [antigravity.google/docs/cli/install](https://antigravity.google/docs/cli/install), authenticate (browser/keyring, or `ANTIGRAVITY_TOKEN` for CI), then set `AGENT_HARNESS=antigravity`. Legacy `AGENT_HARNESS=gemini` still routes to Antigravity with a deprecation warning. Prefer `AGENT_CLI_PATH` / `ANTIGRAVITY_CLI_PATH` / `AGY_CLI_PATH` over `GEMINI_CLI_PATH`.

**Muse Code note:** Harness id is `muse`; the CLI binary is `muse`. Install and authenticate per [Muse Code authentication](https://dev.meta.ai/docs/muse-code/auth), then set `AGENT_HARNESS=muse`. devpm uses the same headless `muse exec --json` integration as devintern. Unattended runs default to `--disable-approval`; `--yolo` is opt-in only.

**Kilo Code note:** Harness id is `kilo-code`; the CLI binary is `kilo`.

**Qwen note:** Qwen Code has no `--model` flag; pick the model in `~/.qwen/settings.json`.

**Advanced spawn tuning** (rarely needed):

```bash
# Retry attempts when the agent CLI path is momentarily missing (e.g. during an auto-update)
# Default: 5
AGENT_SPAWN_ENOENT_RETRIES=5

# Initial backoff delay in milliseconds between retries (doubles each attempt)
# Default: 1000
AGENT_SPAWN_ENOENT_BACKOFF_MS=1000
```

These control how devpm handles a brief window where the agent CLI symlink is missing because the tool is updating itself. The defaults are sufficient for all common auto-updaters.

## Verbose API Logging

Enable detailed API call logging for debugging:

```bash
DEVINTERN_VERBOSE=1
```

When set to `1` or `true`, every API request, response status, and retry attempt is printed to the console. This is useful for diagnosing authentication or connectivity issues. The same effect can be achieved at runtime by passing `--verbose` (or `-v`) to `devpm`.

## No License Required

@devintern/pm is free to use under the FSL license: it performs no license check, trial gate, or `LICENSE_KEY` validation. Just run `devpm init` and start creating tasks.

## Environment File Location

@devintern/pm searches for `.devintern-pm/.env` by traversing up from the current working directory to the project root (the nearest `.git` directory or your home directory). You can run `devpm` from any subdirectory of your project and it will find the correct config automatically.

Run `devpm init` once per project to create this file (guided wizard in a terminal, or `devpm init --yes` for the template).

## CLI Updates

On startup, a globally installed `devpm` checks the npm registry (at most once per day) for a newer `@getdevintern/pm` version.

| Mode                                            | Behavior                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Interactive terminal                            | Offers an update prompt (`Update? (Y/n)`). Accepting installs the new version and re-runs your command. |
| Non-interactive (CI, scripts, piped stdin)      | **Skips install** (safe default). Prints a one-line notice at most once per check window.               |
| Opt-out                                         | `DEVPM_NO_UPDATE=1` (or `DEVINTERN_NO_UPDATE=1`) or `--no-update`                                       |
| Opt-in auto-install (including non-interactive) | `DEVPM_AUTO_UPDATE=1` (or `DEVINTERN_AUTO_UPDATE=1`)                                                    |

Only global npm or bun installs are updated. Monorepo checkouts, `bun link`, and local project `node_modules` installs are left alone.

## Troubleshooting

**"Missing required environment variables"**

- Make sure you've run `devpm init` or copied `.env.example` to `.devintern-pm/.env`
- Verify you've set the variables for your selected `TASK_TRACKER` (not every backend block)

**"API error (401)"**

- Verify your API token is correct for the selected backend
- Check that your credentials match your account
- For GitHub fine-grained tokens on org repos, confirm an admin has approved the token
- For Linear, confirm `LINEAR_API_KEY` is the raw `lin_api_…` value (no `Bearer` prefix), see the [Linear Integration guide](./linear-integration.md#troubleshooting)
- For Azure DevOps, confirm all three variables are set and the PAT has **Work Items (Read & write)**: see the [Azure DevOps Integration guide](./azure-devops-integration.md#troubleshooting)
- For Jira, confirm `JIRA_EMAIL` matches the account that created the API token, see the [Jira Integration guide](./jira-integration.md#troubleshooting)

**"GitHub API error (403)" or "(422)"**

- See the [GitHub Issues Integration guide](./github-integration.md#troubleshooting) for token permissions, repository access, and label setup

**"Unknown agent harness"**

- Check `AGENT_HARNESS` spelling (use kebab-case, e.g. `claude-code`, `grok`, `deepseek`)
- The error lists every valid harness name; pick one from that list
- Ensure the matching CLI is installed and on your `PATH`, or set `AGENT_CLI_PATH` / `<HARNESS>_CLI_PATH`
