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

`devintern doctor` (without `worker`) checks the current checkout's project context, not every repository and team in a workspace, and project `devintern login` does not prove the worker is signed in. Use `worker doctor` and `worker login` for worker setups.
