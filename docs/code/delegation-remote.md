---
title: "Delegate from Another Machine"
sidebarLabel: "Remote Delegation"
description: "Use when a coding agent or script on another machine should delegate to your DevIntern worker over SSH or Tailscale SSH, or through the dashboard API."
section: "Automation"
order: 1.7
dateModified: 2026-11-20
tags: ["worker", "delegation", "worker-add", "ssh", "tailscale", "remote"]
---

# Delegate from Another Machine

Part of [Delegate Tasks to the Worker](./delegation.md).

`devintern worker add` writes to the worker's own `queue.db` and `injected/`
directory, so it must run on the machine that runs the worker. A coding agent
on your laptop, a cloud VM, or a colleague's machine can still delegate: it runs
the same commands on the worker host over SSH. This is plain command execution,
not port forwarding, so you do not need a tunnel, an open dashboard port, or a
DevIntern install on the calling machine.

## Set up access once

If the calling machine can already reach the worker host with SSH keys, skip to
[Check the connection](#check-the-connection).

If the two machines are on different networks (behind NAT, home and office, a
laptop and a cloud box), [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh)
is the shortest path. It needs no inbound port, port forwarding, or SSH key
management:

```bash
# on the worker host
tailscale up --ssh

# on the calling machine: sign in to the same tailnet, then
ssh you@worker-host 'devintern --version'
```

Tailnet identity is the access boundary. Use
[Tailscale ACLs](https://tailscale.com/kb/1018/acls) to limit which devices
and users may SSH into the worker host: anyone who can run commands there can
enqueue tasks that act with your repository credentials.

Optionally add a host alias so commands and agents can refer to the worker by
one name:

```sshconfig
# ~/.ssh/config on the calling machine
Host devintern-worker
  HostName worker-host        # or worker-host.<tailnet>.ts.net
  User you
```

## Check the connection

Non-interactive SSH commands often run without your login shell's `PATH`, so
`devintern` installed under `~/.bun/bin` may not be found. Check that both of
these work from the calling machine:

```bash
ssh devintern-worker 'devintern worker add --help'
ssh devintern-worker 'cat ~/.devintern/workspace.toml'
```

If `devintern` is not found, call it by absolute path
(`~/.bun/bin/devintern`), or add that directory to `PATH` in a file that
non-interactive shells read (for bash, the top of `~/.bashrc`, before any
early return for non-interactive shells).

## Dispatch over SSH

Pass the brief on stdin with `--body-file -` so the remote shell never parses
it. Keep the title in single quotes inside the remote command:

```bash
ssh devintern-worker "devintern worker add --repo backend \
  --title 'Fix checkout retry handling' \
  --idempotency-key checkout-retry-followup \
  --body-file - --json" < /tmp/devintern-task-UNIQUE.md
```

The `--json` result and exit code come back over SSH unchanged. Read the
outcome the same way:

```bash
ssh devintern-worker 'devintern worker runs --task-key <taskKey> --json'
ssh devintern-worker 'devintern worker runs show <id> --json'
ssh devintern-worker 'devintern worker logs --level warn'
```

A few things differ from a local handoff:

- **The worker uses its own checkout.** Commits, branches, and files that exist
  only on the calling machine are invisible to it. Push what the task depends
  on, or copy the needed findings into the brief.
- **`--workspace` paths are on the worker host.** Read `[[repos]]` from the
  worker host's workspace file, not from a local one.
- **Prefer short bounded waits.** A dropped SSH connection ends `--wait` on the
  calling side but not the task. Inspect `worker runs` before enqueueing again.

## Coding agents

The [devintern-delegate skill](agent-skills.md) supports a remote worker. Tell
the agent which SSH host runs the worker ("delegate this to DevIntern on
`devintern-worker`"), or set `DEVINTERN_WORKER_SSH=devintern-worker` in the
agent's environment. The skill then runs every workspace read and `devintern`
command on that host. `DEVINTERN_WORKER_SSH` is a convention for the skill; the
CLI itself does not read it.

## Dashboard API alternative

Callers that can make HTTP requests but cannot run SSH commands can use the
dashboard's `POST /api/tasks` endpoint through an SSH tunnel, Tailscale Serve,
or an authenticating reverse proxy. It takes the same fields and returns the
same result as `worker add --json`; see
[Delegate a task](dashboard.md#delegate-a-task) and
[Access the dashboard from another device](dashboard.md#access-the-dashboard-from-another-device).
It cannot `--wait`, and it needs the worker's dashboard to be running.
