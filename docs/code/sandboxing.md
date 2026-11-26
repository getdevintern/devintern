---
title: "Sandboxing the Agent"
sidebarLabel: "Sandboxing"
description: "Use when confining DevIntern Code agent runs with an OS-level sandbox (native, nono, or Docker Sandboxes), restricting writable paths or network domains, or troubleshooting a sandboxed run."
section: "Automation Reference"
order: 0.2
dateModified: 2026-11-18
---

# Sandboxing the Agent

Agents run with their own permission prompts turned off (like `--dangerously-skip-permissions`), so by default they can do anything your user account can. A sandbox confines each agent run at the OS level. This matters most for unattended worker runs.

```bash
# ~/.devintern/.env (every repo) or ~/.devintern/env/<repo>.env (one repo)
AGENT_SANDBOX=auto
```

Or for a single run: `devintern PROJ-123 --sandbox nono`.

Run `devintern sandbox` to see which providers are installed, the setup each one still needs, the provider `auto` would pick for each harness in `AGENT_HARNESS`, and what your next run will do. It exits non-zero when the current configuration is certain to fail, so CI can gate on it.

A one-shot run picks up a changed `AGENT_SANDBOX` immediately. A running `devintern worker` needs a restart.

## Providers

| `AGENT_SANDBOX` | What it is                                                                                                                                | Works with                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `none`          | No sandbox (default)                                                                                                                      | all harnesses                                          |
| `auto`          | Best option per harness: `native` first, then `nono`. Runs unsandboxed with a warning if neither is available. Never picks `docker`        | depends on pick                                        |
| `native`        | The harness's built-in sandbox, configured by DevIntern. Nothing to install                                                               | `claude-code`, `codex`                                 |
| `nono`          | Kernel-enforced isolation of the whole agent process (Landlock on Linux, Seatbelt on macOS). See [nono.sh](https://nono.sh)               | all harnesses                                          |
| `docker`        | A [Docker Sandboxes](https://www.docker.com/products/docker-sandboxes) microVM, run through the `sbx` CLI                                  | `claude-code`, `codex`, `cursor`, `opencode`           |

If you name a provider that isn't installed or doesn't support your harness, the run fails with an error instead of running unsandboxed. In a failover chain, worker runs skip any fallback entry the provider can't wrap. Interactive and PR-review runs use only the first entry, so that one must work.

If DevIntern is already running inside a kernel sandbox (a `nono` shell, or launched by another sandboxed agent), it doesn't add a second layer, because nested kernel sandboxes fail to start. The agent stays inside the outer sandbox instead. A `docker` microVM can still run inside another sandbox.

### Setup at a glance

| Provider | Install                                                                                                                  | Agent login inside the sandbox                                                     | One-time setup                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `native` | Nothing                                                                                                                  | Your existing login                                                                | None                                                                              |
| `nono`   | macOS: `brew install nono`; Linux: `curl -fsSL https://nono.sh/install.sh \| sh`                                         | Your existing login                                                                | `nono pull nolabs-ai/<agent>` for each agent that has a pack ([nono profiles](#nono-profiles)) |
| `docker` | macOS: `brew install docker/tap/sbx`; Windows: `winget install Docker.sbx`; Linux: `docker-sbx` (Docker's apt repo or the AUR) | An API key stored with `sbx secret set -g anthropic` (or `openai`, `google`, `github`, …). Host logins aren't visible inside the VM | `sbx login` (Docker Desktop only), then `sbx policy init balanced`                 |

## What the sandbox allows

By default the agent can **write** to:

- the project working directory, the task output directory, and the system temp directory
- the Playwright and Puppeteer browser caches
- the harness's own state directories (`~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.grok`, …)
- in workspace runs, the workspace `injected/`, `state/`, and `automations/` directories, which `devintern worker add` and automation cursors need

The rest of your home directory stays readable but not writable. Network access is open, so agents can reach model APIs, git remotes, and package registries.

| Variable                         | Effect                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `AGENT_SANDBOX_WRITABLE_PATHS`   | More writable paths, colon-separated (`/data/scratch:/var/cache/myapp`)                                        |
| `AGENT_SANDBOX_ALLOWED_DOMAINS`  | Limit network access to these domains, comma-separated (`api.anthropic.com,github.com`). Enforced by `nono`, `docker`, and Claude Code `native` |
| `AGENT_SANDBOX_NONO_PROFILE`     | Use your own nono profile, by name or absolute path, instead of the default                                     |

Narrowing `AGENT_SANDBOX_ALLOWED_DOMAINS` to your model API, package registries, and git host is the biggest single hardening step. Expect the first few runs to fail until the list is complete.

## Pinning the agent CLI

Toolchain directories such as `~/.local/share/mise` aren't writable inside the sandbox. A CLI installed behind a mise shim therefore fails, even though the real binary works. Point `<HARNESS>_CLI_PATH` at the real binary instead:

```bash
GROK_CLI_PATH=/home/you/.grok/bin/grok
```

`devintern doctor` flags shims and suggests the right variable. See [CLI path](./agent-harness.md#cli-path) for how the variables are named.

## nono profiles

Under `nono`, each run uses a **profile** plus the write permissions listed above.

| Case                 | Profile                                                                                         | Applies to                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Pack profile         | The harness's official pack, installed with `nono pull nolabs-ai/<agent>`                       | `claude-code`, `codex`, `opencode`, `goose`, `pi`, `antigravity`                |
| Generic fallback     | `linux-host-compat` on Linux, nono's default on macOS                                           | Every other harness (`grok`, `cline`, `qwen`, `kimi`, `muse`, `cursor`, …)      |
| Your own profile     | The profile named by `AGENT_SANDBOX_NONO_PROFILE`, used as-is                                   | Whenever you set it                                                             |

Install the pack for every harness that has one. Packs grant access that plain flags can't, such as the macOS Keychain. Without the claude pack, `claude-code` under nono reports "Not logged in" on macOS. When no pack exists, DevIntern uses the generic fallback, says so once per run, and `devintern sandbox` lists it for each entry. Browse packs at [registry.nono.sh](https://registry.nono.sh).

To use your own profile, save it under `~/.config/nono/profiles/` and set `AGENT_SANDBOX_NONO_PROFILE=my-profile`. DevIntern doesn't add the pack on top of your profile, so extend it yourself if you need it:

```json
{
  "extends": ["linux-host-compat", "claude-code"],
  "meta": { "name": "my-profile", "description": "host compatibility + the Claude pack" },
  "filesystem": { "read": ["/etc"] }
}
```

DevIntern's write permissions (working directory, output directory, state directories, `/dev/ptmx`, the ssh-agent socket) still apply on top of your profile.

## Provider notes

**native.** For Claude Code, this is the sandboxed Bash tool: it confines shell commands and their child processes, but not the agent's built-in file tools. For Codex, it is `--sandbox workspace-write`. The agent understands its own sandbox errors and adapts. If you want a boundary around the whole process, use `nono`. Antigravity isn't supported in native mode; use `nono` with it.

**nono.** Wraps the whole agent process, so it works with every harness and with worktree-based flows such as `address-review`. On Linux it works without extra profile setup, and PTY tools such as lefthook work. On macOS, DevIntern turns off Codex's and Muse's inner sandbox to avoid nesting; nono is the boundary there.

**docker.** The agent runs in a Linux microVM with your project directory mounted. Paths under `/tmp` aren't mounted, so review worktree flows don't work; use `nono`, or move `DEVINTERN_OUTPUT_DIR` out of `/tmp`. DevIntern adds network rules for each run (open, or your `AGENT_SANDBOX_ALLOWED_DOMAINS`) and removes them afterwards, leaving your global `sbx` policy as it was.

**Git over SSH.** Works out of the box under `nono` on Linux. On macOS, Seatbelt blocks `~/.ssh` keys. Load your key into the agent with `ssh-add`, whose socket is forwarded into the sandbox, and allow `known_hosts` with a profile like this, selected with `AGENT_SANDBOX_NONO_PROFILE=claude-code-ssh`:

```json
{
  "extends": "claude-code",
  "meta": { "name": "claude-code-ssh", "description": "claude-code pack + git push over ssh" },
  "filesystem": {
    "read_file": ["$HOME/.ssh/known_hosts"],
    "bypass_protection": ["$HOME/.ssh/known_hosts"]
  }
}
```

**Browser automation.** Playwright works under `nono` on Linux without changes. On macOS, Chromium needs extra Seatbelt permissions ([nono#1019](https://github.com/nolabs-ai/nono/issues/1019)). Select this profile with `AGENT_SANDBOX_NONO_PROFILE=claude-code-browser`, or use `docker` instead:

```json
{
  "extends": "claude-code",
  "meta": { "name": "claude-code-browser", "description": "claude-code pack + Chromium launch support" },
  "unsafe_macos_seatbelt_rules": [
    "(allow iokit-open (iokit-user-client-class \"RootDomainUserClient\") (iokit-user-client-class \"IOSurfaceRootUserClient\"))",
    "(allow iokit-get-properties)",
    "(allow mach-register)"
  ]
}
```

## Claude Code native sandbox details

With `AGENT_SANDBOX=native` and `AGENT_HARNESS=claude-code`, DevIntern generates a settings file for each run and passes it with `--settings`:

| Setting                             | Value                                                         | Why                                                                                        |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sandbox.enabled`                   | `true`                                                        | Turns on the Bash-tool sandbox                                                             |
| `sandbox.autoAllowBashIfSandboxed`  | `true`                                                        | The sandbox takes the place of permission prompts                                          |
| `sandbox.allowUnsandboxedCommands`  | `false`                                                       | Stops blocked commands from being retried outside the sandbox                              |
| `sandbox.failIfUnavailable`         | `true`                                                        | If the sandbox can't start (for example, `bubblewrap` is missing on Linux), the run fails instead of running unsandboxed |
| `sandbox.filesystem.allowWrite`     | Working, output, and temp directories; browser caches         | What a task needs to write                                                                 |
| `sandbox.network.allowedDomains`    | `["*"]` or your `AGENT_SANDBOX_ALLOWED_DOMAINS`               | Nobody is there to approve new domains during a headless run                               |
| `sandbox.network.allowLocalBinding` | `true`                                                        | Dev servers and browser automation need localhost                                          |
| `sandbox.network.allowUnixSockets`  | Your `SSH_AUTH_SOCK`, if set                                  | `git push` over SSH                                                                        |
| `sandbox.excludedCommands`          | `["docker *", "gh *"]`                                        | `docker` doesn't work in the sandbox, and `gh` fails TLS checks on macOS; both run outside it as they would without a sandbox |

If you don't want the `docker` and `gh` exceptions, use `nono`. Claude Code merges array settings from all scopes, so your project or user `.claude/settings.json` can add to the generated policy. Settings worth considering:

- `sandbox.credentials` (`deny` or `mask`): stops sandboxed commands from reading files like `~/.aws/credentials`. Denying `~/.ssh` breaks SSH pushes.
- `sandbox.network.deniedDomains` and `sandbox.filesystem.denyRead`: block specific domains or paths.
- More `excludedCommands` for tools that break in the sandbox. Each one is a hole in the boundary.
- `sandbox.enableWeakerNestedSandbox` (Linux): only needed inside an unprivileged container that already provides isolation.

Organization-managed Claude Code settings (`allowManagedDomainsOnly` and related keys) can lock the policy down centrally.

## Isolating at the machine level

Some workloads can't run under any of these providers. Examples are Xcode and the iOS Simulator, Unity builds that need a GPU or licensing daemons, and tests on attached devices. The microVM guests are Linux, so they can't run macOS tooling either. For these, keep `AGENT_SANDBOX=none` and isolate the whole machine:

- Use a dedicated VM (on Apple Silicon, [Tart](https://tart.run) or UTM for macOS; a Windows or Linux VM for Unity). Take a snapshot before agent runs and roll back afterwards.
- Or use a separate machine or cloud runner, such as a spare Mac mini or an EC2 Mac instance.
- Install DevIntern there and run it as usual, with credentials scoped to that machine: a machine user or deploy key, and least-privilege tokens.

A disposable VM snapshot is a stronger guarantee than filesystem confinement, at the cost of setup effort and hardware.
