# Older CLIs

Use these fallbacks only when the installed CLI's `--help` lacks a flag or command the runbook uses. Prefer upgrading with `bun install -g @getdevintern/code` when the user agrees.

| Missing from `--help` | Fallback |
| --- | --- |
| `worker init --non-interactive` | `devintern worker scaffold`, then `devintern worker add-repo` in the checkout. Set `[defaults].tracker` and `task_query` in `workspace.toml`, put credentials in the workspace `.env` (mode `0600`), and verify with `worker doctor` |
| `worker login --no-wait` | Ask the user to run `devintern worker login <method>` in a terminal on the worker host |
| `worker connect --json` or `--no-wait` | Ask the user to run `devintern worker connect <target>` in a terminal on the worker host |
| `worker doctor --json` | Run `devintern worker doctor` without it and read the ❌, ⚠️, and 👉 rows; the exit codes are the same (0 ready, 2 only sign-in left, 1 failed) |
| `worker doctor` | Validate `workspace.toml` by hand against the [workspace guide](https://devintern.com/docs/code/workspaces). There is no `worker validate` command |
| `worker service` | Follow the [service guide](https://devintern.com/docs/code/worker#running-as-a-service), including Bun and agent `PATH` and unattended git authentication |
| `worker status`, `overview`, `logs` | Read the worker's log files or the dashboard at `http://localhost:4400` |

## Before the headless next-step contract

Older CLIs print `worker doctor --json` without a `setup` field. On those:

- `nextSteps[].command` may block (bare `worker login github`, bare `worker connect`, foreground `devintern worker`). Use the runbook commands instead: `sign-in` is step 4, `connect` is step 6, `service` and `start` are step 5. An `install-agent` command may use npm on a host without it; use `bun install -g <package>` instead.
- Each new `worker login --no-wait` or `--sign-in` run replaces the waiting sign-in and invalidates its URL. Do not rerun it while the user is signing in, and show only the newest URL.
- `worker init` keeps its files even when a check fails, and rerunning it with other flags without `--yes` does not report `workspace_exists`. Delete the `--env-file` by hand after a successful init.
- `service install` restarts a running worker; do not repeat it to check status.
- Setup is done when `worker doctor --json` returns `success` with no `fail` checks and no `sign-in` or `install-agent` next step, `worker service status --json` reports `running` (or the user chose not to start it), and `worker status --json` shows the worker running.

`devintern doctor` (without `worker`) checks the current checkout's project context, not every repository and team in a workspace, and project `devintern login` does not prove the worker is signed in. Use `worker doctor` and `worker login` for worker setups.
