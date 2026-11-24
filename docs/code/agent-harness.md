---
title: "Agent Harness Configuration"
sidebarLabel: "Agent Harness"
description: "Use when choosing which AI agent CLI DevIntern Code runs, setting its model or reasoning effort, configuring failover across agents, or overriding the agent per task."
section: "Automation Reference"
order: 0.1
dateModified: 2026-11-18
---

# Agent Harness Configuration

The **harness** is the AI agent CLI that DevIntern Code runs to do the work. Set it in the repository's env file `~/.devintern/env/<repo>.env` (or the workspace `.env` for every repo):

```bash
AGENT_HARNESS=claude-code        # default
# AGENT_MODEL=sonnet             # optional, harness-specific model string
# AGENT_EFFORT=medium            # optional: low | medium | high
# AGENT_CLI_PATH=/custom/claude  # optional, only if the CLI isn't on PATH
```

Usually `AGENT_HARNESS` is all you need. DevIntern finds the harness's standard command on your `PATH`.

## Supported harnesses

| `AGENT_HARNESS`                | CLI binary     | Notes                                                                                                                        |
| ------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` (alias `claude`) | `claude`       | Default                                                                                                                      |
| `codex`                        | `codex`        |                                                                                                                              |
| `opencode`                     | `opencode`     |                                                                                                                              |
| `cursor`                       | `cursor-agent` | Enable the CLI in Cursor's settings. `--max-turns` has no effect                                                             |
| `grok`                         | `grok`         | Grok Build, from [x.ai/cli](https://x.ai/cli). Log in through the browser or set `XAI_API_KEY`. `--max-turns` has no effect  |
| `deepseek` (alias `dsh`)       | `dsh`          | Experimental: DeepSeek's official DeepSeek Harness. See [DeepSeek Harness](#deepseek-harness)                                |
| `reasonix`                     | `reasonix`     | `npm i -g reasonix`, then set `DEEPSEEK_API_KEY` or run `reasonix setup`. `--max-turns` has no effect                        |
| `antigravity` (alias `agy`)    | `agy`          | Replaces the retired Gemini CLI. Log in through the browser or set `ANTIGRAVITY_TOKEN` for CI. Models come from `agy models` |
| `muse` (alias `muse-code`)     | `muse`         | Requires Muse Code 1.4.9+. See [Muse Code](#muse-code)                                                                       |
| `cline`                        | `cline`        |                                                                                                                              |
| `goose`                        | `goose`        |                                                                                                                              |
| `kilo-code`                    | `kilo`         |                                                                                                                              |
| `kimi`                         | `kimi`         |                                                                                                                              |
| `qwen`                         | `qwen`         | Set the model with `AGENT_MODEL` (for example `qwen3-coder-plus`) or in `~/.qwen/settings.json`                              |

`AGENT_HARNESS=gemini` still works but routes to Antigravity and prints a deprecation warning. DevIntern never starts the retired `gemini` binary.

`AGENT_HARNESS=deepseek` used to select Reasonix. It now selects the official DeepSeek Harness, so existing Reasonix setups must switch to `AGENT_HARNESS=reasonix`. DevIntern prints this hint when `dsh` is missing or a `*_CLI_PATH` still points at `reasonix`.

### Muse Code

Install Muse Code with `curl -fsSL https://dev.meta.ai/install.sh | sh` and check that `muse --version` reports 1.4.9 or newer. Sign in interactively the first time, or set `META_API_KEY` for workers and CI. The default model is `muse-spark-1.2`; to change it, set `AGENT_MODEL`/`MUSE_MODEL` or pass `--model`. `--max-turns` maps to Muse's model-step limit.

DevIntern runs `muse exec` so that it never stops to ask a question. Muse's own sandbox stays on, and its network is opened because nobody is there to approve requests (any outer sandbox's domain allowlist still applies). DevIntern never trusts the workspace for you, so a project's `AGENTS.md`, skills, and hooks load only after you trust that checkout yourself. Don't trust checkouts from untrusted PRs or forks. On macOS under `nono`, Muse requires `META_API_KEY`. An exit code of `0` means the turn finished, not that the task or your tests passed. See Meta's [authentication](https://dev.meta.ai/docs/muse-code/auth) and [permissions](https://dev.meta.ai/docs/muse-code/permissions) docs.

### DeepSeek Harness

The `deepseek` harness runs DeepSeek's [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It is a developer preview, and upstream expects breaking changes. DevIntern was verified against `@deepseek-ai/dsh` 0.2.1-rc.2 and warns once when a different version is installed.

1. Install Node.js and the CLI: `npm i -g @deepseek-ai/dsh` (or point `DEEPSEEK_CLI_PATH` at a wrapper). An unrelated `dsh`, such as Debian's distributed shell, is refused.
2. Set `DEEPSEEK_API_KEY` in `.devintern-code/.env` or `$DSH_HOME/.env`. Headless mode ignores credentials saved by the dsh GUI; to reuse them, see the [headless bundle docs](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/headless#credentials).
3. Set `AGENT_HARNESS=deepseek`.

| Setting               | Behavior                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model and effort      | Set in the dsh profile (`agent-default-model` in `$DSH_HOME/profiles/headless/cordis.patch.yml`; default `deepseek-flash`). `AGENT_MODEL` and `AGENT_EFFORT` are ignored with a warning                                                    |
| `--max-turns`         | No headless equivalent. A non-default value prints a warning                                                                                                                                                                               |
| `DSH_PERMISSION_MODE` | Unattended runs default to `danger-full-access`, because headless dsh can't answer approval prompts. Set `workspace-write` to keep dsh's own sandbox; work that needs escalation is then rejected                                          |
| `DSH_HOME`            | Honored from the environment or `.devintern-code/.env`. Under nono, only a `~/.dsh*` directory or one inside the workspace is granted; set `DEVINTERN_SANDBOX_ALLOW_CUSTOM_DSH_HOME=1` in the launch environment to trust another location |

## CLI path

Set `AGENT_CLI_PATH` only when the CLI isn't on your `PATH` or has a non-standard name. It accepts a bare command or a full path. Don't commit an absolute path to a shared `.env`, because paths differ between machines. If the command can't be found, DevIntern exits at startup with an error.

To pin a specific harness, use `<HARNESS>_CLI_PATH`: the harness id in upper case, with dashes turned into underscores. Examples are `CLAUDE_CODE_CLI_PATH` (legacy name: `CLAUDE_CLI_PATH`), `CODEX_CLI_PATH`, `OPENCODE_CLI_PATH`, `GROK_CLI_PATH`, `MUSE_CLI_PATH`, `DEEPSEEK_CLI_PATH`, `REASONIX_CLI_PATH`, `KILO_CODE_CLI_PATH`, `ANTIGRAVITY_CLI_PATH`, and `AGY_CLI_PATH` (`GEMINI_CLI_PATH` is legacy). Under a sandbox, point this at the real binary rather than a mise shim; see [Pinning the agent CLI](./sandboxing.md#pinning-the-agent-cli).

## Models

`AGENT_MODEL` is passed to every agent run. Its format depends on the harness, for example a Claude Code alias such as `sonnet`, an OpenAI model ID for Codex, or a slug from `agy models`. Harnesses that have no model flag ignore it.

DevIntern picks the model for each run in this order:

1. `<HARNESS>_MODEL` (`CLAUDE_CODE_MODEL`, `CODEX_MODEL`, `OPENCODE_MODEL`, `GROK_MODEL`, …), if set.
2. `AGENT_MODEL`, which applies to a single harness or to the first entry of a chain.
3. Otherwise, the harness's own default.

## Reasoning effort

`AGENT_EFFORT=low|medium|high` controls how hard the agent thinks on each run. Any other value is an error. Leave it unset to keep the harness default.

Claude Code, Codex, Grok, Antigravity, Reasonix, Muse, Cline, OpenCode, and Kilo Code each map it to their own flag. Other harnesses ignore it and print a warning (the `deepseek` harness names its profile file instead). pi and OpenCode v2 build the effort into the model string, so on those it only takes effect when a model is configured.

## Failover across multiple harnesses

Give `AGENT_HARNESS` a comma-separated list in priority order, and the worker keeps running when one agent hits a usage limit:

```bash
AGENT_HARNESS=opencode,grok
OPENCODE_MODEL=opencode-go/deepseek-v4.1-flash
GROK_MODEL=grok-4.7
```

- At startup the worker checks each entry and skips any that are unknown, not installed, or unable to start under the configured sandbox. It then logs the resulting chain and each entry's model.
- When an agent reports a usage limit, the worker waits until the reset time in the limit message. If the message has none, it waits 1 hour, doubling up to 24 hours on repeated limits. Meanwhile it retries the work on the next agent that has capacity, and returns to the first agent once that agent's limit resets.
- If every agent is limited, new work waits until the first limit resets. Failover state survives worker restarts.
- Failover applies to every worker job: tracker tasks, PR reviews, `@mentions`, conflict resolution, automations, estimations, retries, and `devintern webhook serve`. Interactive `devintern TASK-123` runs always use the first entry.
- Run records show which harness ran each job. The webhook server's `/health` endpoint shows the active harness and any open limits.

`AGENT_CLI_PATH` and `AGENT_MODEL` apply **only to the first entry**, because model IDs and paths are specific to each provider. Give each fallback its own `<HARNESS>_MODEL` and, if needed, `<HARNESS>_CLI_PATH`.

## Per-task overrides

A task description can choose the harness, model, and effort for that one task:

```markdown
## Execution preferences

Harness: codex
Model: gpt-5.2
Effort: high
```

Each line is optional. `Model:` is passed to the harness exactly as written. Setting only `Harness:` doesn't carry `AGENT_MODEL` over; that harness uses its `<HARNESS>_MODEL` or its default model. Invalid or conflicting values fail the task with an error message. For the full syntax, including the hidden-comment form and trackers that flatten headings, see [Per-task execution preferences](./usage.md#per-task-execution-preferences).

## Read-only analysis runs

The clarity check and story-point estimation never write to your repository. On harnesses with a read-only or plan mode (`claude-code`, `codex`, `cursor`, `grok`, `opencode`, `muse`), DevIntern uses that mode for these runs automatically. Other harnesses run them unrestricted. If a restricted run errors out, DevIntern retries it once in the normal mode.

To let analysis runs use extra tools, such as an MCP server during the clarity check, list them (comma-separated, using the harness's tool names):

```bash
AGENT_ANALYSIS_ALLOWED_TOOLS=mcp__notion,mcp__figma__get_design_context
```

This only applies to harnesses that support read-only mode.

## Related settings

- Run timeouts, turn limits, and hook retries: [Execution limits](./advanced-settings.md#execution-limits)
- Confining the agent: [Sandboxing the Agent](./sandboxing.md)
- Checking that every harness in the chain can start: `devintern doctor` ([Readiness check](./advanced-settings.md#readiness-check))

A running `devintern worker` reads `.env` only at startup, so restart it after you change `AGENT_HARNESS`.
