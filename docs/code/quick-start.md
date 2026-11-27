---
title: "DevIntern Code Quick Start"
sidebarLabel: "Quick Start"
description: "Use when installing DevIntern Code for the first time: set up a worker that turns ready tracker tickets into pull requests, or run one task by hand."
section: "Automation"
order: 0
dateModified: 2026-11-27
tags: ["devintern/code", "quick start", "worker", "jira", "github", "cli"]
---

# DevIntern Code Quick Start

DevIntern Code runs your AI coding agent on tickets from Jira, Linear, Trello, Asana, Azure DevOps, GitHub Issues, or GitLab Issues, or on local markdown files. It creates a feature branch, commits the changes, and opens a pull request.

The recommended setup is a **worker**: a background service that picks up ready tickets, opens PRs, and follows up on review comments. It suits one repository as well as many. To try a single task by hand first, see [Run one task by hand](#run-one-task-by-hand).

Prefer to set up from a chat? Install the [devintern-setup skill](agent-skills.md) and ask your coding agent to do it.

## Prerequisites

- A Linux or macOS machine that will run the worker, with `git`
- A clone of your project's repository on that machine
- A task tracker account with API access, or a folder of markdown tasks
- A token for your source-control host so the worker can push and open PRs. For GitHub, see [GitHub authentication](./configuration.md#github-authentication); a signed-in GitHub CLI (`gh`) is reused when `GITHUB_TOKEN` is unset

## 1. Install

Install DevIntern Code with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/getdevintern/devintern/main/scripts/install.sh | sh
```

The script installs [Bun](https://bun.sh) if it is missing, installs `@getdevintern/code` globally, adds `~/.bun/bin` to your shell profile, and prints the installed version. It is safe to re-run and upgrades DevIntern to the latest version. As root it installs missing system packages such as `unzip`; otherwise it prints the `sudo` command and stops. It never runs `sudo` itself. Set `DEVINTERN_VERSION` to install a specific version, or `DEVINTERN_NO_MODIFY_PATH=1` to leave your shell profile alone.

Then install and sign in to a coding agent:

```bash
curl -fsSL https://claude.ai/install.sh | bash   # Claude Code, the default agent
claude                                           # sign in once, then exit
```

### Install manually

Install Bun. On Debian and Ubuntu, the Bun installer needs `unzip`:

```bash
sudo apt-get install -y unzip   # Debian/Ubuntu only
curl -fsSL https://bun.sh/install | bash
```

The installer adds `~/.bun/bin` to your shell profile, which only takes effect in a new shell. Open a new terminal, or run `exec $SHELL -l`. Then install DevIntern and a coding agent:

```bash
bun install -g @getdevintern/code
curl -fsSL https://claude.ai/install.sh | bash   # Claude Code, the default agent
claude                                           # sign in once, then exit
```

`devintern --version` confirms the install. To use Codex, Cursor, OpenCode, or another agent instead, install and sign in to its CLI and see [Agent Harness](./agent-harness.md).

## 2. Set up the worker

In your project's checkout:

```bash
devintern init
```

In a checkout that is not set up yet, it first asks how you want to run tickets. Choose **1) Automatically with a worker** (the default) to start the worker setup; `devintern worker init` opens the same wizard directly. If you already set the repository up for manual runs, run `devintern worker init` here instead: it reuses the tracker settings it saved and turns the manual-only entry into a worker repository. The wizard first checks this machine: the agent CLI from step 1, git, and whether a background service can be installed. If the agent CLI or git is missing, it tells you right away how to install it, and you can continue anyway or stop. It then asks for:

1. Your tracker and its token. It links to the page where you create the token and checks the connection.
2. The ready-tasks query: which tickets the worker picks up. Press Enter to pick up open tickets labeled `devintern` (for example `is:open label:devintern` on GitHub Issues), or type your own query; keep it narrow at first. On GitHub and GitLab it offers to create the `devintern` label if it is missing.
3. Nothing about worker settings: a new workspace gets the recommended ones (no CI repair, automatic conflict resolution, task pickup at any hour, no Sentry project). Change them in `~/.devintern/workspace.toml`, or run `devintern worker init --customize` to choose each one and add a Sentry project.
4. "Sign in with GitHub to start your 14-day Worker Pilot": one question that starts the [14-day free Worker Pilot](./worker.md#worker-pilot-and-licenses) (no card required) and pairs the [relay](./relay.md), so PR reviews reach the worker in seconds. For a GitHub repository it opens the DevIntern AI App install page and waits for you to approve it. Press Enter during either wait to skip; `devintern worker login github` signs you in later, and `devintern worker connect github --status` finishes an App approval you gave after skipping. To sign in with Google, X or email instead, skip the step and run `devintern worker login <method>`. You are not asked when you are already signed in or have a `LICENSE_KEY`. Add `--no-relay` to keep polling only.
5. Installing the background service (step 3 below).

Your answers are saved in `~/.devintern/`; nothing is written into your checkout. Re-run `devintern worker init` at any time: it keeps your answers as defaults and finishes a setup that stopped partway, including one you stopped with Ctrl+C.

No tracker account yet? Choose **Markdown files**. Tasks are read from a folder and need no credentials. See [Markdown File Tasks](./markdown-tasks.md).

## 3. Start the worker in the background

If you skipped the wizard's last step, install the service now:

```bash
devintern worker service install
```

It runs the [`worker doctor`](./worker.md#checking-readiness-worker-doctor) checks, installs a systemd user service (Linux) or launchd agent (macOS), starts it, and waits until the worker is running. It then prints the dashboard address. If a check fails, it lists the fix and installs nothing.

From then on the worker polls your tracker every 60 seconds for tickets that match your query. On Linux, run `sudo loginctl enable-linger $USER` once so the worker keeps running after you log out and starts at boot; `service install` warns you when this is needed.

## 4. Watch the first task run

When the wizard has started the worker, it ends with one more question: "Create a sample ticket so you can watch the first run? [Y/n]". The sample is a small docs-only task (add a short note to `CONTRIBUTING.md`) whose title says it is a DevIntern sample:

| Tracker           | What the wizard creates                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| GitHub, GitLab    | An issue with the labels your query selects on (`label:devintern`). On GitHub, an ad-hoc task instead when the repository you registered is not `GITHUB_REPO` |
| Markdown          | A task file in your tasks folder with the fields your query filters on (`status=todo`)                     |
| Any other tracker | An ad-hoc task queued with [`devintern worker add`](./delegation.md); no ticket                             |

It then waits up to two minutes for the worker to start the task and prints the dashboard link to the run. Answer `n` and nothing is created. If your query selects on something setup cannot set (an assignee, a milestone), the wizard tells you to make the ticket match it yourself. `worker init --non-interactive` never creates a sample; it lists the command as the optional `try-first-task` next step.

To try your own ticket, make it match your query, for example by adding the `devintern` label to a GitHub issue. Within a minute or two the worker picks it up. Follow it in:

- The dashboard at `http://localhost:4400`. On a remote machine, forward it first: `ssh -L 4400:127.0.0.1:4400 you@host`
- `devintern worker runs` for the run list, and `devintern worker logs --level warn` for problems
- `devintern worker prs` for the pull requests it opened

The run checks the ticket is clear enough, implements it, and opens a PR. Review the PR and leave comments; the worker pushes follow-up commits to the same branch. A ticket that is too vague gets questions on the tracker instead of a PR.

Nothing picked up after a few minutes? Run `devintern doctor` in the checkout (in a worker repository it runs the `devintern worker doctor` checks) and see [Worker Troubleshooting](./worker-troubleshooting.md).

## Run one task by hand

To try one task without a worker, run `devintern init` in your checkout and choose **2) By hand from this terminal**. Interactive runs are free and need no sign-in.

```bash
devintern init      # choose 2, then connect a tracker or choose Markdown files
devintern doctor    # check that everything is wired up
```

Then run a task. With a tracker, pass the task reference. With Markdown, add `TASK-1.md` to your task folder and pass its name without the extension:

```bash
devintern PROJ-123 --create-pr
devintern TASK-1
```

`devintern init` saves your answers to `~/.devintern/env/<repo>.env` and registers the repository as manual-only, so a worker skips it. To hand it to a worker later, run `devintern worker init` in the checkout: it reuses those settings and turns the repository into a worker repository.

## Next steps

- [Worker](./worker.md): options, readiness checks, service management, and licenses.
- Open the guide for your tracker: [Jira](./jira-integration.md), [Linear](./linear-integration.md), [Trello](./trello-integration.md), [Asana](./asana-integration.md), [Azure DevOps](./azure-devops-integration.md), [GitHub Issues](./github-issues-integration.md), or [GitLab](./gitlab-integration.md).
- [Workspaces](./workspaces.md): add more repositories and teams to the same worker.
- [CLI reference](./usage.md): flags, batch queries, and git behavior.
- [Reporting Bugs](./reporting-bugs.md): if a failure looks like a DevIntern defect, `devintern report` files a redacted report.
