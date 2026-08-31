---
title: "@devintern/code Configuration"
sidebarLabel: "Configuration"
description: "Environment variables, settings.json, tracker credentials, and agent harness options for @devintern/code."
section: "Code"
order: 2
dateModified: 2026-08-26
---

# @devintern/code Configuration

@devintern/code uses per-project configuration stored in `.devintern-code/.env` in your project directory. This allows you to work with multiple projects without configuration conflicts.

The easiest way to create this file is `devintern init`. In a terminal it runs an interactive wizard: pick your tracker, follow the deep link to the provider's token page, paste the credentials, and the wizard verifies the connection before writing `.env`. Pass `--yes` (or `--no-interactive`) to skip the prompts and generate a commented template to fill in by hand, which is also what happens automatically when stdin is not a terminal (CI, scripts).

## Environment File Locations

The tool searches for `.env` files in the following order:

1. **Custom path** (if specified with `--env-file`)
2. **Project discovery**: traverses up from the current working directory, checking `.devintern-code/.env` then `.env` at each level, stopping at the first `.git` root found or your home directory
3. **User home directory** (`~/.env`)
4. **Tool installation directory**

You can run `devintern` from any subdirectory of your project and it will find the correct config automatically.

## Required Configuration

The active task tracker is set with `TASK_TRACKER` (defaults to `jira`). Supported values: `jira`, `linear`, `trello`, `asana`, `azure-devops`, `github`, `gitlab`, `markdown`.

### Jira (default)

Update your `.env` file with your Jira credentials:

```bash
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=your-email@company.com
JIRA_API_TOKEN=your-api-token
```

Get your Jira API token at [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

See the [Jira Integration guide](./jira-integration.md) for setup, JQL batch runs, and troubleshooting.

### Linear

Set `TASK_TRACKER=linear` and provide a Personal API key:

```bash
TASK_TRACKER=linear
LINEAR_API_KEY=lin_api_xxxxxxxxxxxx
```

Create a Personal API key at [https://linear.app/settings/api](https://linear.app/settings/api). Story points are written to Linear's built-in `estimate` field, so no custom field ID is required.

See the [Linear Integration guide](./linear-integration.md) for state transitions and JSON `IssueFilter` batch runs. For unattended drains, use the [worker](./worker.md).

### Trello

Set `TASK_TRACKER=trello` and provide Power-Up credentials:

```bash
TASK_TRACKER=trello
TRELLO_API_KEY=your-power-up-api-key
TRELLO_API_TOKEN=your-user-token
TRELLO_DEFAULT_BOARD_ID=abc123        # optional: board short ID from the board URL
```

See the [Trello Integration guide](./trello-integration.md) for token generation and list transition setup.

### Markdown (local files)

To use local `.md` files as tasks without any PM credentials, set the tracker to `markdown` and point it at your tasks directory:

```bash
TASK_TRACKER=markdown
MARKDOWN_TASKS_DIR=/path/to/tasks
```

`MARKDOWN_TASKS_DIR` is required when `TASK_TRACKER=markdown`. `devintern` resolves bare task keys (e.g. `my-feature`) to `{MARKDOWN_TASKS_DIR}/my-feature.md`.

You can also pass file paths directly as arguments without setting `TASK_TRACKER=markdown` at all. In that mode no `.devintern-code/.env` is needed for tracker credentials. See the [Markdown File Tasks guide](./markdown-tasks.md) for details.

## GitHub authentication

**Personal / interactive:** a `GITHUB_TOKEN` (personal access token). That is enough for free CLI use from your terminal (`devintern TICKET-123`, `--create-pr`).

**Team / unattended automation:** a GitHub App (`GITHUB_APP_ID` plus a private key). That is what `@mention` matching, `devintern webhook serve`, and `slug[bot]` commit attribution need so the bot has a shared team identity. Unattended runs also need a `LICENSE_KEY`. See [Pricing](https://devintern.com/pricing/).

The two credentials are complementary, not drop-in replacements. A team setup that also uses GitHub Issues as the tracker still needs `GITHUB_TOKEN`.

| What you want | Need |
| --- | --- |
| Implement tickets and open PRs from the CLI (personal) | `GITHUB_TOKEN` |
| Use GitHub Issues as the task tracker (`TASK_TRACKER=github`) | `GITHUB_TOKEN` (the App cannot substitute) |
| Worker review polling on the agent's own PRs | `GITHUB_TOKEN` (solo) or GitHub App (if already configured) |
| `@mention` the bot on any PR (worker sweep or webhook) | GitHub App (`GITHUB_APP_ID` + private key) |
| Commits attributed to `slug[bot]` | GitHub App |

Set both when you run mention-driven automation and also use GitHub Issues as a tracker. See [GitHub Issues Integration](./github-issues-integration.md) and [GitHub Integration](./github-integration.md).

**Precedence when both are set:**

- CLI and PR creation use `GITHUB_TOKEN`
- `devintern webhook serve` prefers the App so the bot identity (`slug[bot]`) resolves

Do not set `GITHUB_APP_ID` without `GITHUB_APP_PRIVATE_KEY_PATH` or `GITHUB_APP_PRIVATE_KEY_BASE64`. The ID alone is ignored for auth, but the worker treats it as "GitHub credentials present."

### Bot mention aliases

Mention matching resolves the bot login from your configured GitHub App. When a relay-managed worker should also react to the DevIntern AI App's identity — whose private key stays on DevIntern infrastructure and is never available locally — add its login as an alias:

```bash
GITHUB_BOT_ALIASES=devintern-ai
```

The value is a comma-separated list of logins (with or without the `[bot]` suffix). Aliases count everywhere mentions are matched: commented reviews, inline comment scopes, and the `@mention` sweep. A worker connected to the relay (`devintern worker connect`) injects `devintern-ai` automatically; set the variable explicitly when running a custom App alongside it or without the relay.

### Which feedback gets re-processed

Addressed feedback is tracked locally in the worker's state database, so a comment is never processed twice on the same machine. A 🎉 reaction is also left on each addressed comment as visual feedback for humans — it carries no gating meaning, so reaction-permission problems can never cause feedback to be re-processed.

### GitHub Personal Access Token

For personal / interactive CLI use, and for `TASK_TRACKER=github`:

```bash
GITHUB_TOKEN=your-github-token
```

- **Classic token**: Requires `repo` scope
- **Fine-grained token** (recommended): Requires `Pull requests: Read and write` and `Contents: Read and write` permissions. Add `Issues: Read and write` when `TASK_TRACKER=github`
- Create at: [https://github.com/settings/tokens](https://github.com/settings/tokens)

> **`Contents` must be *Read and write*, not Read.** Branch pushes go through the same credential as everything else, and a Contents-readonly token passes every API check (task fetch, PR reads) while `git push` fails with `403 ... denied to <login>`. If your setup delegates pushing to an SSH remote instead (`git@github.com:owner/repo.git`), the PAT does not need `Contents: Write` for pushes.

#### How git picks push credentials

Pushes use git's ambient credential chain — devintern does not inject tokens into `git push`:

1. If `gh auth git-credential` is configured (typical with the GitHub CLI) and `$GITHUB_TOKEN` is exported in the environment, **the environment variable wins over your keyring login**. An under-scoped `GITHUB_TOKEN` therefore silently overrides a working `gho_…` login.
2. Otherwise the keyring/token-helper credentials apply.
3. SSH remotes use your SSH keys.

The worker dry-runs a push against each configured GitHub HTTPS remote at startup and warns when it is rejected (`✅ [fleet] push access verified for <repo>` / a `⚠️ [fleet] … rejects pushes` line), so credential problems surface before the first task burns its pickup.

### GitHub App Authentication

For team / unattended automation (`@mention` matching, `webhook serve`, `slug[bot]` commit attribution):

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/secure/path/to/your-app.private-key.pem
```

Both the ID and a private key are required.

**Benefits:**

- Can create PRs without a personal token (team/automation setups)
- Fine-grained permissions
- Centralized control
- Audit trail
- Resolves the bot identity required for `@mention` matching

**Setup steps:**

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set repository permissions:
   - **Contents:** Read and write
   - **Pull requests:** Read and write
   - **Issues:** Read and write
3. Generate and save a private key
4. Install the App on your repositories

> These permissions cover task implementation, PR creation, and the 🎉 reaction left on addressed feedback. The reaction is cosmetic only — whether feedback needs action is decided from the local state database — so a missing reaction permission never causes re-processing. If reactions fail with a permissions error after a settings change, re-approve the installation; already-issued credentials keep working for up to an hour. If you also run the webhook server or mention sweep to auto-address PR feedback, that App needs additional **Pull request review comments** and **Issue comments** permissions plus event subscriptions; see [GitHub Integration](./github-integration.md#update-app-permissions).

For CI/CD environments, you can use a base64-encoded key:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_BASE64=LS0tLS1CRUdJTi4uLg==
```

To encode your key:

```bash
# macOS
base64 -i your-app.private-key.pem

# Linux
base64 -w 0 your-app.private-key.pem
```

### Bitbucket

```bash
BITBUCKET_TOKEN=your-bitbucket-token
```

Requires `Repositories: Write` permission. Create at [https://bitbucket.org/account/settings/app-passwords/](https://bitbucket.org/account/settings/app-passwords/)

## Per-Project Settings

The `.devintern-code/settings.json` file allows project-specific behavior. Settings are organized by task tracker, so you can configure multiple trackers in one file.

```json
{
  "jira": {
    "projects": {
      "PROJ": {
        "prStatus": "In Review",
        "inProgressStatus": "In Progress",
        "todoStatus": "To Do",
        "storyPointsField": "customfield_10016"
      }
    }
  },
  "linear": {
    "projects": {
      "ENG": {
        "prStatus": "In Review",
        "inProgressStatus": "In Progress",
        "todoStatus": "Backlog"
      }
    }
  },
  "trello": {
    "projects": {
      "abc123": {
        "prStatus": "Review",
        "inProgressStatus": "Doing",
        "todoStatus": "To Do"
      }
    }
  }
}
```

The active tracker is read from the `TASK_TRACKER` environment variable (defaults to `jira`). Run `devintern init` to generate a `settings.json` with examples for all supported trackers.

**Fields (all optional):**

- `prStatus`: Status/state/label to transition to after PR creation (e.g., "In Review")
- `inProgressStatus`: Status to set when starting work (e.g., "In Progress", "Doing")
- `todoStatus`: Status to reset to if implementation fails (e.g., "To Do", "Backlog")
- `storyPointsField`: Custom field ID for story points (e.g., `"customfield_10016"` for Jira); auto-discovered if omitted

**Supported trackers:** `jira`, `linear`, `trello`, `asana`, `azure-devops`, `github`, `gitlab`, `markdown`.

**Backward compatibility:** Existing Jira-only files using the legacy top-level `projects` key continue to work without any changes.

```json
{
  "projects": {
    "PROJ": {
      "prStatus": "In Review"
    }
  }
}
```

## Verbose API Logging

To enable detailed API call logging for debugging, set the `DEVINTERN_VERBOSE` environment variable:

```bash
DEVINTERN_VERBOSE=1
```

This logs every API call, response, and retry attempt to the console. Leave it unset (the default) for quiet operation.

## Error Reporting

The CLI reports crashes and unhandled errors to DevIntern's Sentry project by default. To opt out:

```bash
SENTRY_DISABLED=1
```

Set this in your shell environment or in `.devintern-code/.env`.

## Anonymous Usage Analytics

The CLI sends one anonymous usage event per run to DevIntern's PostHog project so we can understand popularity and which features are used. It never sends task content, code, repository names, file paths, or credentials — only:

- CLI version, OS, architecture
- Active tracker type (e.g. `jira`, `linear`) and run mode (tasks / query / estimate)
- Task count and boolean feature flags (`--create-pr`, `--auto-review`, `--estimate`, sandbox provider)
- Whether the session runs in CI

A random anonymous ID is generated once per project and stored in `.devintern-code/telemetry.json`. Analytics are disabled automatically when running from source. To opt out, either:

```bash
# Shell or .devintern-code/.env
DEVINTERN_TELEMETRY_DISABLED=1
```

or set in `.devintern-code/settings.json`:

```json
{
  "analytics": { "enabled": false }
}
```

See [devintern.com/privacy](https://devintern.com/privacy/) for details.

## Readiness Check

Run `devintern doctor` for a one-screen answer to "is everything set up?":

```bash
devintern doctor
```

It checks, in order:

- **Bun runtime** and **Git** availability
- **AI agent CLI**: whether your configured harness (`AGENT_HARNESS`, default `claude-code`) is installed and on `PATH`; suggests an installed alternative or install steps when not
- **Task tracker credentials**: required environment variables for your `TASK_TRACKER` in `.devintern-code/.env`
- **DevIntern sign-in**: local session validity (`devintern login` when missing)
- **License**: entitlement status when signed in (only needed for unattended automation)

Each failing row gets a fix hint. The command exits non-zero when any check fails, so scripts and CI can gate on it. The interactive `devintern init` wizard runs a subset of these checks automatically at the end of setup.

## Output Directory

By default, task artifacts are saved to `/tmp/devintern-tasks`. You can customize this:

```bash
DEVINTERN_OUTPUT_DIR=./devintern-output
```

Everything in the output directory is a debug artifact and safe to delete. Retry bookkeeping (which tasks were reported incomplete, and when) lives in `.devintern-code/queue.db` in your project instead, so it survives reboots.

**Output structure:**

```
{output-dir}/{task-key}/
├── task-details.md                      # Formatted task for AI agent
├── feasibility-assessment.md            # Clarity check results
├── implementation-summary.md            # Success output
├── implementation-summary-incomplete.md # Failure output
├── auto-review-summary.json             # Auto-review loop results
├── iteration-{N}/                       # Auto-review iterations
│   ├── feedback.json
│   └── review-prompt.txt
└── attachments/                         # Jira attachments
```

## Agent Harness

Configure which AI agent runs and how long it can work:

```bash
# Agent harness type (default: claude-code)
AGENT_HARNESS=claude-code

# Optional: path to the agent CLI (leave unset in most cases)
# AGENT_CLI_PATH=/custom/path/to/claude

# Optional: model the harness runs with (harness-specific string)
# AGENT_MODEL=sonnet
```

You usually only need `AGENT_HARNESS`. By default devintern uses the harness's standard command (for example `claude` for `claude-code`) and finds it on your `PATH` automatically, so `AGENT_CLI_PATH` can be left unset.

Common `AGENT_HARNESS` values include `claude-code`, `opencode`, `codex`, `cursor`, `grok`, `deepseek`, `antigravity`, `cline`, `goose`, `kilo-code`, `kimi`, and `qwen`. If you do need to set a path explicitly, run `which` for the harness binary (`claude`, `opencode`, `codex`, `cursor-agent`, `grok`, `reasonix`, `agy`, `cline`, `goose`, `kilo`, `kimi`, or `qwen`).

**Cursor note:** The Cursor harness uses Cursor's headless `cursor-agent` CLI (not a command named `cursor`). Cursor also installs an `agent` alias, but devintern looks for `cursor-agent` because other tools use the `agent` name too. Install Cursor and enable the CLI from Cursor's settings, then set `AGENT_HARNESS=cursor`. The `--max-turns` option has no effect with this harness; Cursor runs until the task is complete.

**Grok note:** Product name is Grok Build; the CLI binary is `grok`. Install from [x.ai/cli](https://x.ai/cli), authenticate (browser login or `XAI_API_KEY`), then set `AGENT_HARNESS=grok`. `--max-turns` has no effect; Grok runs until the task completes.

**DeepSeek note:** Harness id is `deepseek`; the CLI binary is `reasonix` (DeepSeek-Reasonix, listed in DeepSeek's agent integrations). Install with `npm i -g reasonix`, set `DEEPSEEK_API_KEY` (or run `reasonix setup`), then set `AGENT_HARNESS=deepseek`. `--max-turns` and permission-skip flags have no effect on `reasonix run` (turn limits live in Reasonix config; headless runs are already autonomous).

**Antigravity note:** Harness id is `antigravity` (alias `agy`); the CLI binary is `agy`. Google retired consumer Gemini CLI on 2026-06-18 in favor of Antigravity CLI. Install from [antigravity.google/docs/cli/install](https://antigravity.google/docs/cli/install), authenticate (browser/keyring, or `ANTIGRAVITY_TOKEN` for CI), then set `AGENT_HARNESS=antigravity`. Legacy `AGENT_HARNESS=gemini` still routes to Antigravity with a deprecation warning; DevIntern does not spawn the retired `gemini` binary. Prefer `AGENT_CLI_PATH` / `ANTIGRAVITY_CLI_PATH` / `AGY_CLI_PATH` over `GEMINI_CLI_PATH`. `--max-turns` has no effect; model selection accepts slugs from `agy models` via `AGENT_MODEL`.

**Kilo Code note:** Harness id is `kilo-code`; the CLI binary is `kilo`.

**Qwen note:** Qwen Code accepts a model via its `--model` flag (e.g. `qwen3-coder-plus`) — set it with `AGENT_MODEL`; you can also keep the model in `~/.qwen/settings.json`.

### Model selection

Set the model the agent harness runs with using `AGENT_MODEL` in `.devintern-code/.env`:

```bash
# .devintern-code/.env
AGENT_MODEL=sonnet
```

The model string is harness-specific — see your harness's CLI docs for accepted values (e.g. Claude Code aliases like `sonnet`, Codex/OpenAI model IDs, Antigravity slugs from `agy models`). DevIntern passes it to every agent spawn (implementation runs, analysis, reviews, and hook fixes). A few harnesses have no model flag and ignore the setting.

Set `AGENT_CLI_PATH` only when the CLI is not on your `PATH` or uses a non-standard name. You can give it a bare command name or a full path. Avoid committing an **absolute** path to a shared `.env`: it is machine-specific, so copying an `.env` from macOS (`/Users/...`) to a Linux host (`/home/...`) would point at a non-existent binary. If the configured command cannot be found, devintern fails fast at startup with a message telling you the CLI is not on your `PATH`.

**Advanced spawn tuning** (rarely needed):

```bash
# Retry attempts when the agent CLI path is momentarily missing (e.g. during an auto-update)
# Default: 5
AGENT_SPAWN_ENOENT_RETRIES=5

# Initial backoff delay in milliseconds between retries (doubles each attempt)
# Default: 1000
AGENT_SPAWN_ENOENT_BACKOFF_MS=1000
```

These control how devintern handles a brief window where the agent CLI symlink is missing because the tool is updating itself. The defaults are sufficient for all common auto-updaters.

**CLI options:**

- `--agent-path`: override the agent executable path
- `--max-turns`: max turns for **implementation** (default: **500**; clarity checks always use 10)
- `--skip-clarity-check`: skip feasibility assessment before implementation

DevIntern always runs the full workflow after fetching a task (clarity check → agent → commit/PR). There is no fetch-only mode.

## Sandboxing the Agent

Agents run with their own permission prompts disabled (the equivalent of `--dangerously-skip-permissions`), so by default they have the same access to your machine as your user account. DevIntern can wrap every agent run in an OS-level sandbox so the agent stays confined even in fully automated worker runs.

```bash
# In the workspace .env (~/.devintern/.env)
AGENT_SANDBOX=auto
```

Or per interactive run:

```bash
devintern PROJ-123 --sandbox nono
```

Run `devintern sandbox` at any time for a full diagnosis: which providers are installed, the one-time setup steps each still needs, which one `auto` would pick, and exactly what your next run will do with the current configuration, including why it would fail. The command exits non-zero when the configured provider guarantees a failed run, so scripts and CI can gate on it.

### Providers

| Value    | What it is                                                                                                                                                                                  | Works with                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `none`   | No sandboxing (default)                                                                                                                                                                     | all harnesses                                          |
| `auto`   | Best available option (native, then nono, then srt); runs unsandboxed with a warning if none is available. Providers needing per-user setup (docker, smolvm) are never picked automatically | depends on pick                                        |
| `native` | The harness's own built-in OS sandbox, enabled and configured by DevIntern. Zero install, nothing to set up                                                                                 | `claude-code`, `codex`                                 |
| `nono`   | Kernel-enforced isolation (Landlock on Linux, Seatbelt on macOS), zero setup ([nono.sh](https://nono.sh))                                                                                   | all harnesses                                          |
| `srt`    | [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime): sandbox-exec on macOS, bubblewrap on Linux (`npm install -g @anthropic-ai/sandbox-runtime`)         | all harnesses                                          |
| `docker` | [Docker Sandboxes](https://www.docker.com/products/docker-sandboxes) microVM via the `sbx` CLI; never picked by `auto` (requires per-user setup, see below)                                 | `claude-code`, `codex`, `cursor`, `gemini`, `opencode` |
| `smolvm` | [SmolVM](https://docs.celesto.ai/smolvm/introduction) microVM with a dedicated in-VM browser sandbox; never picked by `auto`                                                                | `claude-code`, `codex`, `pi`                           |

If you explicitly select a provider that is not installed or does not support your harness, the run fails with an actionable error rather than silently running unsandboxed.

### What the sandbox allows

The default policy confines filesystem writes to what a task run actually needs: your project working directory, the task output directory, the system temp directory, and the Playwright and Puppeteer browser caches (so agents that launch a browser for testing or research keep working). Network access stays open, since agents need to reach model APIs, push to git remotes, and install packages.

Optional restrictions:

```bash
# Extra writable paths (colon-separated)
AGENT_SANDBOX_WRITABLE_PATHS=/data/scratch:/var/cache/myapp

# Restrict network egress to specific domains (strictly enforced by srt;
# nono and docker apply it via their own network filters; smolvm ignores it)
AGENT_SANDBOX_ALLOWED_DOMAINS=api.anthropic.com,github.com

# nono: use a custom profile instead of nono's default scope
AGENT_SANDBOX_NONO_PROFILE=my-profile
```

### Provider setup at a glance

Every provider needs its tool installed; some also need auth or one-time configuration before the first sandboxed run. `devintern sandbox` reports missing pieces per provider.

| Provider | Install                                                                                                                         | Agent auth inside the sandbox                                                                                                 | One-time setup                                                                                                                | Picked by `auto` | Docs                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `native` | none (built into the harness)                                                                                                   | Your existing agent login                                                                                                     | none                                                                                                                          | yes (first pick) | [native sandbox details](#claude-code-native-sandbox-details)                |
| `nono`   | macOS: `brew install nono`; Linux: `curl -fsSL https://nono.sh/install.sh \| sh`                                                | Your existing agent login (the agent pack grants macOS Keychain access)                                                       | Per agent: `nono pull nolabs-ai/<agent>` (packs exist for claude, codex, opencode, goose, pi, antigravity; Sigstore-verified) | yes              | [nono.sh/docs](https://nono.sh/docs)                                         |
| `srt`    | `npm install -g @anthropic-ai/sandbox-runtime` (+ `bubblewrap`, `socat`, `ripgrep` on Linux)                                    | Your existing agent login                                                                                                     | none, but the network runs on an explicit allowlist (see below)                                                               | yes              | [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) |
| `docker` | macOS: `brew install docker/tap/sbx`; Windows: `winget install Docker.sbx`; Linux: `docker-sbx` (Docker's apt repo, or the AUR) | API key via `sbx secret set -g anthropic` (also `google`, `github`, `openai`, ...); host logins are not visible inside the VM | `sbx login` (Docker Desktop; not needed on native Linux), then `sbx policy init balanced`                                     | no               | [docs.docker.com/ai/sandboxes](https://docs.docker.com/ai/sandboxes/)        |
| `smolvm` | `curl -sSL https://celesto.ai/install.sh \| bash`                                                                               | Host agent credentials are forwarded automatically                                                                            | first run downloads a guest VM image (several minutes); Linux also needs KVM and your distro's QEMU system package            | no               | [docs.celesto.ai/smolvm](https://docs.celesto.ai/smolvm/introduction)        |

### Provider notes

- **native** uses the sandbox already built into the harness: Claude Code's sandboxed Bash tool (see [Claude Code native sandbox details](#claude-code-native-sandbox-details) for the exact generated configuration) and Codex's `--sandbox workspace-write`. It needs no installation, and the agent understands its own sandbox errors, so it retries intelligently instead of failing on mysterious permission errors. Scope caveat: for Claude Code the native sandbox confines shell commands and their child processes, not the agent's built-in file tools. For a boundary around the whole agent process, use `nono` or `srt`. Antigravity (the Gemini CLI successor) is not supported in native mode: its built-in sandbox covers shell commands only and is bypassed during unattended runs, so use `nono` or `srt` with it.
- **nono and srt** wrap the agent process directly, so any harness works and worktree-based flows (webhook reviews, `address-review`) are fully supported. On Linux, srt also requires `bubblewrap`, `socat`, and `ripgrep`. DevIntern translates the sandbox policy into each tool's own configuration, including read access to your home directory and write access to the agent's own state files (without which agents start logged out). When one of these wraps Codex on macOS, DevIntern automatically disables Codex's own sandbox for that run (nested macOS sandboxes are unsupported; the outer wrapper is the enforcement boundary). On Linux both layers stack.
- **nono** works best with the official agent pack for your harness installed: run `nono pull nolabs-ai/<agent>` once (packs exist for `claude`, `codex`, `opencode`, `goose`, `pi`, and `antigravity`; each is Sigstore-verified on pull), and DevIntern automatically uses the pack profile for matching runs. The packs carry grants plain flags cannot express, such as macOS Keychain access; without the claude pack, `claude-code` under nono reports "Not logged in" on macOS. Browse packs at [registry.nono.sh](https://registry.nono.sh). On Linux, DevIntern generates a composite profile combining the pack (when installed) with nono's built-in `linux-host-compat` profile plus `/etc` read access, and automatically resolves Landlock conflicts between broad read grants and nono's protected paths, so runs work out of the box with no profile setup. DevIntern also grants `/dev/ptmx` so tools that allocate a PTY (for example lefthook during `git commit`) work inside the sandbox.
- **srt cannot run with a fully open network.** Its settings schema requires an explicit domain allowlist and rejects `*`, so with no `AGENT_SANDBOX_ALLOWED_DOMAINS` set, DevIntern applies a built-in allowlist of agent essentials: model APIs (Anthropic, OpenAI, Google), git hosts (GitHub, GitLab, Bitbucket), and the common package registries (npm, PyPI, crates.io, Go, Maven). A task that needs another host will see its requests denied with a 403; add the domain via `AGENT_SANDBOX_ALLOWED_DOMAINS`. Localhost is unaffected (local binding is always allowed for dev servers and browser automation).
- **Docker Sandboxes** run the agent inside a microVM that mounts your project directory as the workspace. It now ships as the standalone `sbx` CLI (the old `docker sandbox` plugin was removed). One-time setup: install `sbx` (see the table above), sign in with `sbx login` on Docker Desktop (native Linux with the local daemon needs no sign-in), run `sbx policy init balanced`, and store an API key for the in-VM agent with `sbx secret set anthropic` (the guest agent cannot use your host login). Host paths under `/tmp` are not part of the mounted workspace, so review worktree flows are not supported with this provider; use `nono` or `srt` for those, or move `DEVINTERN_OUTPUT_DIR` out of `/tmp`. Network follows the sandbox policy: DevIntern adds per-sandbox rules on top of your global `sbx` policy, allowing all hosts by default (the open-network policy) or exactly your `AGENT_SANDBOX_ALLOWED_DOMAINS` list when set. The rules are scoped to each run's sandbox and removed with it, so your global `sbx policy init` choice still governs everything you run outside DevIntern.
- **SmolVM** is the strongest option for browser-heavy workloads (it can run a full browser inside the VM), and it forwards your host agent credentials into the sandbox automatically. Each run boots a fresh microVM with your working directory mounted read-write at its host path, runs the agent inside it, and deletes the VM afterward; the first run downloads a guest image, which takes several minutes. It is a young project, so you must opt in explicitly with `AGENT_SANDBOX=smolvm`. On Linux, DevIntern runs SmolVM with its QEMU backend (workspace mounts need it), which requires KVM (`/dev/kvm`) and your distro's QEMU system package (for example `qemu-system-x86` plus `qemu-img`); `devintern sandbox` reports both when missing. Note the name collision: this provider targets [CelestoAI SmolVM](https://docs.celesto.ai/smolvm/introduction) (installed via `curl -sSL https://celesto.ai/install.sh | bash`), not the unrelated smol-machines microVM runner that installs a binary with the same name; `devintern sandbox` detects and reports the wrong one.
- **Git over ssh** behaves differently per wrapper and OS. Under `nono` on Linux, ssh pushes work out of the box: the reads-open policy leaves `~/.ssh` readable (Landlock cannot re-deny inside an explicit grant, so this matches the srt behavior where key files also stay readable) and the ssh-agent socket is forwarded when present. Under `nono` on macOS, Seatbelt keeps private keys in `~/.ssh` blocked; load your key into the ssh-agent instead (`ssh-add ~/.ssh/id_rsa`, the agent socket is forwarded into the sandbox) and grant read access to `~/.ssh/known_hosts` with a small user profile, saved to `~/.config/nono/profiles/` and selected via `AGENT_SANDBOX_NONO_PROFILE=claude-code-ssh`:

  ```json
  {
    "extends": "claude-code",
    "meta": {
      "name": "claude-code-ssh",
      "description": "claude-code pack + git push over ssh (keys stay in the ssh-agent)"
    },
    "filesystem": {
      "read_file": ["$HOME/.ssh/known_hosts"],
      "bypass_protection": ["$HOME/.ssh/known_hosts"]
    }
  }
  ```

  Under `srt`, all traffic goes through its HTTP proxy and raw ssh connections cannot resolve or reach hosts, so use HTTPS git remotes there.

- **Browser automation inside the sandbox** depends on the wrapper and OS. Under `nono` on Linux, standard Playwright launches work unchanged (the composite profile grants the system reads Chromium needs). Under `srt` on Linux, launch Chromium with `chromium.launch({ args: ["--disable-gpu"] })`; Chromium's own sandbox can stay on, and note that the macOS single-process recipe does not work on Linux. Under `srt` on macOS, Playwright works when Chromium is launched with its own sandbox off and in single-process mode (`chromium.launch({ chromiumSandbox: false, args: ["--single-process", "--no-sandbox"] })`); the outer sandbox still confines the whole process. Under `nono` on macOS, Chromium needs a user profile that opts into a few Seatbelt capabilities the default policy blocks (tracked upstream in [nono#1019](https://github.com/nolabs-ai/nono/issues/1019)); with the profile below saved to `~/.config/nono/profiles/` and selected via `AGENT_SANDBOX_NONO_PROFILE=claude-code-browser`, standard Playwright launches work unchanged:

  ```json
  {
    "extends": "claude-code",
    "meta": {
      "name": "claude-code-browser",
      "description": "claude-code pack + Chromium launch support"
    },
    "unsafe_macos_seatbelt_rules": [
      "(allow iokit-open (iokit-user-client-class \"RootDomainUserClient\") (iokit-user-client-class \"IOSurfaceRootUserClient\"))",
      "(allow iokit-get-properties)",
      "(allow mach-register)"
    ]
  }
  ```

  SmolVM's in-VM browser is the alternative when you'd rather not extend the wrapper policy.

- Changing `AGENT_SANDBOX` in `.env` applies to the next one-shot run immediately. A running `devintern worker` daemon reads `.env` at startup, so restart it after changing the value (same as `AGENT_HARNESS`).

### Claude Code native sandbox details

With `AGENT_SANDBOX=native` and `AGENT_HARNESS=claude-code`, DevIntern generates a settings file for each run and passes it to the agent with `--settings`. This is what it contains and why:

| Setting                             | Value                                                                    | Why                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.enabled`                   | `true`                                                                   | Turns the Bash-tool sandbox on                                                                                                                                                                                                   |
| `sandbox.autoAllowBashIfSandboxed`  | `true`                                                                   | Sandboxed commands run without prompts; the sandbox boundary replaces the permission prompt                                                                                                                                      |
| `sandbox.allowUnsandboxedCommands`  | `false`                                                                  | Closes the escape hatch. By default Claude Code may retry a sandbox-blocked command outside the sandbox; combined with skip-permissions that retry would be silently approved, making the sandbox advisory instead of a boundary |
| `sandbox.failIfUnavailable`         | `true`                                                                   | If the sandbox cannot start (for example missing `bubblewrap` on Linux), the run fails with a clear error instead of silently running unsandboxed. You explicitly asked for isolation, so DevIntern never quietly drops it       |
| `sandbox.filesystem.allowWrite`     | working directory, task output directory, temp directory, browser caches | The write set a DevIntern task actually needs                                                                                                                                                                                    |
| `sandbox.network.allowedDomains`    | `["*"]` (or your `AGENT_SANDBOX_ALLOWED_DOMAINS` list)                   | The sandbox default is deny-with-prompt for every new domain. In non-interactive runs nobody can approve the prompt, so with the escape hatch closed all network commands would fail. Open must be stated explicitly             |
| `sandbox.network.allowLocalBinding` | `true`                                                                   | Dev servers and browser automation bind to localhost; the sandbox blocks that by default                                                                                                                                         |
| `sandbox.network.allowUnixSockets`  | your `SSH_AUTH_SOCK`, when set                                           | Lets `git push` over SSH reach the ssh-agent                                                                                                                                                                                     |
| `sandbox.excludedCommands`          | `["docker *", "gh *"]`                                                   | See below                                                                                                                                                                                                                        |

**Why `docker` and `gh` are excluded.** Claude Code's own documentation lists `docker` as incompatible with the sandbox, and Go-based CLIs such as `gh` fail TLS verification under macOS sandboxing. Because DevIntern closes the unsandboxed-retry escape hatch, these commands would hard-fail inside the sandbox and there would be no fallback. Excluding them means they run outside the sandbox, which is exactly how they run today without any sandbox: for these two commands the native provider is no worse than the status quo, and everything else stays confined. If you do not want these exceptions, use `nono` or `srt` instead, which wrap the whole process without per-command carve-outs.

**Extending the generated configuration.** Claude Code merges settings across scopes: array settings such as `allowWrite`, `denyRead`, and `excludedCommands` combine entries from every scope, so your own `.claude/settings.json` (project) or `~/.claude/settings.json` (user) can narrow or widen the policy DevIntern generates. Settings worth considering that DevIntern does not set for you:

- `sandbox.credentials`: the sandbox's default read policy still allows reading files like `~/.ssh` and `~/.aws/credentials`. Credential entries with `"mode": "deny"` block those reads and unset secret environment variables for sandboxed commands. `"mode": "mask"` goes further: the command sees a placeholder and the sandbox proxy injects the real value only for requests to hosts you list, so tools keep authenticating without ever holding the secret (requires `network.tlsTerminate`). DevIntern leaves this to you because denying `~/.ssh` breaks SSH-based git pushes, and the right trade-off depends on your remotes and threat model.
- `sandbox.network.deniedDomains`: block specific domains even when the broad allow-all is in place, for example known exfiltration endpoints.
- Narrower `AGENT_SANDBOX_ALLOWED_DOMAINS`: replacing allow-all with a real allowlist (model API, package registries, your git host) is the single biggest hardening step, at the cost of the first run failing until the list is complete.
- `sandbox.filesystem.denyRead`: block reads of specific paths (private repos checked out elsewhere, secret stores) while keeping the rest of the policy.
- `sandbox.allowAppleEvents` (macOS): off by default and DevIntern keeps it off; enabling it lets sandboxed commands script other applications, which removes much of the isolation. Only relevant if a task genuinely needs `open` or `osascript`.
- `sandbox.enableWeakerNestedSandbox` (Linux): needed only when the agent itself runs inside an unprivileged container; weakens isolation, so enable it only when the container already provides the boundary.
- Additional `excludedCommands`: if a tool your tasks rely on is incompatible with the sandbox (the upstream docs mention `watchman`-based `jest` runs and some Go CLIs), adding an exclusion in your project settings is the intended mechanism. Each entry is a hole in the boundary, so keep the list short.

One structural note: entries you add in project settings can widen the policy (that is by design upstream); organization-managed Claude Code settings can lock this down with `allowManagedDomainsOnly` and related keys if you need central control.

### When a sandbox wrapper is the wrong tool: isolate at the machine level

Some workloads cannot run under any of the providers above. The iOS Simulator and Xcode builds need system Mach services, code signing daemons, and often a GUI session; Unity and other game-engine builds need GPU access and licensing daemons; device testing needs real hardware attached. The microVM providers do not help either: their guests are Linux, so macOS-only tooling cannot run inside them.

For these cases, keep `AGENT_SANDBOX=none` and move the isolation boundary from the process to the machine:

- **A dedicated VM.** On Apple Silicon, a macOS VM (for example [Tart](https://tart.run) or UTM) runs Xcode and the iOS Simulator with full fidelity; snapshot the VM before agent runs and roll back afterwards. For Unity batch builds, a Windows or Linux VM works the same way.
- **A separate machine or cloud runner.** A spare Mac mini, an EC2 Mac instance, or a hosted macOS provider for Apple toolchains; any throwaway cloud VM for the rest.
- **DevIntern runs there unchanged.** Install the tool on that machine, keep the project's `.devintern-code/.env` there, and run one-shot tasks or a `devintern worker` daemon exactly as you would locally.
- **Scope credentials to the machine.** Use a machine user or deploy key for git, least-privilege tracker and API tokens, and no personal sign-ins beyond the agent login. The isolation then comes with a clear recovery path: if a run goes wrong, roll back the snapshot and rotate only that machine's credentials.

This is not a fallback of last resort. A snapshotted VM gives you a stronger guarantee than filesystem confinement (the whole disk state is disposable), at the cost of setup effort and hardware.

## Read-only analysis runs

The internal analysis-only spawns, feasibility/clarity check and story point estimation, never write to your repository. On harnesses with native read-only or plan-mode enforcement (`claude-code`, `codex`, `cursor`, `grok`, `opencode`), devintern runs them through that mode automatically and never combines it with a permission-skip flag. Harnesses without native enforcement (for example `antigravity`, `deepseek`, `cline`, `goose`, `kilo-code`, `kimi`, `qwen`) fall back to the previous unattended behavior for these two spawns only; your main implementation run is unaffected either way. If a constrained analysis run errors out, devintern retries it once in the default mode automatically. There's no flag to configure this; it's automatic based on what the harness supports.

```bash
# Optional: extend the tool allowlist for read-only analysis runs (comma-separated,
# harness tool naming), e.g. to allow an MCP server during the clarity check
# AGENT_ANALYSIS_ALLOWED_TOOLS=mcp__notion,mcp__figma__get_design_context
```

`AGENT_ANALYSIS_ALLOWED_TOOLS` only applies when the resolved harness supports read-only mode; it has no effect otherwise.

## CLI Updates

On startup, a globally installed `devintern` checks the npm registry (at most once per day) for a newer `@getdevintern/code` version.

| Mode                                                | Behavior                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Interactive terminal                                | Offers an update prompt (`Update? (Y/n)`). Accepting installs the new version and re-runs your command. |
| Non-interactive (CI, workers, scripts, piped stdin) | **Skips install** (safe default). Prints a one-line notice at most once per check window.               |
| Opt-out                                             | `DEVINTERN_NO_UPDATE=1` or `--no-update`                                                                |
| Opt-in auto-install (including non-interactive)     | `DEVINTERN_AUTO_UPDATE=1`                                                                               |

Only global npm or bun installs are updated. Monorepo checkouts, `bun link`, and local project `node_modules` installs are left alone.

To upgrade immediately without waiting for the prompt or notice, reinstall globally with the package manager you installed with:

```bash
bun install -g @getdevintern/code@latest
# or
npm install -g @getdevintern/code@latest
```

Update-check state (last check time, seen version) is cached per package in `~/.devintern/update-check.json`; delete that file to force a fresh registry lookup on the next run.

## Troubleshooting

**"Missing required environment variables"**

- Ensure `.env` file exists in `.devintern-code/` or your current directory
- Check that variable names match exactly (case-sensitive)

**"Not in a git repository"**

- Run `git init` if starting a new project
- Or use `--no-git` flag to skip git operations

**"Claude CLI not found"** / **"<Harness> CLI not found"**

- Install your AI agent CLI and ensure it is on your `PATH`
- Or specify path: `--agent-path /path/to/claude` (or set `AGENT_CLI_PATH`)

**"Unknown agent harness"**

- Check `AGENT_HARNESS` spelling (use kebab-case, e.g. `claude-code`, `grok`, `deepseek`)
- The error lists every valid harness name; pick one from that list
