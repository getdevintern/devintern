# Sandbox e2e coverage

Scope: sandbox providers (`nono`, `native`, `docker`, `auto`, removed `srt`/`smolvm`), workspace grants, the `--sandbox` flag, and the `devintern sandbox` doctor.

Run: `bun run --filter @devintern/e2e test` (build the CLI first); the sandbox suites are `tests/local/sandbox.test.ts`, `tests/local/sandbox-harness-chain-worker.test.ts`, `tests/local/sandbox-workspace-grants.test.ts` and `tests/local/sandbox-workspace-grants-worker.test.ts`.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### nono availability, preflight, write boundary, fail-closed, inheritance (when installed)

- Surface: External dependency: sandboxing
- Status: `default`
- Evidence: `tests/local/sandbox.test.ts`
- Missing: Network policy and pack updates.
- Last reviewed: 2026-11-17

### `auto` provider selection

- Surface: External dependency: sandboxing
- Status: `partial`
- Evidence: `tests/local/sandbox.test.ts` (single harness: native for claude-code, nono for goose; `claude-code,opencode` chain: per-harness doctor decision, native for claude-code, nono for opencode when installed, unsandboxed warning for opencode when nono is off `PATH`, docker never picked even with a ready stub `sbx`); run with `bun run --filter @devintern/e2e test`
- Missing: Native harness path, fallback when the preferred provider exists but cannot start. A real worker run of an `auto` chain (the per-harness decision is covered through the doctor only).
- Last reviewed: 2026-11-27

### `native` provider (claude-code, codex)

- Surface: External dependency: sandboxing
- Status: `partial`
- Evidence: `tests/local/sandbox.test.ts`
- Missing: Real agent run under the native sandbox (needs an agent account); preflight/doctor covered with stubs.
- Last reviewed: 2026-11-17

### `docker` provider

- Surface: External dependency: sandboxing
- Status: `partial`
- Evidence: `tests/local/sandbox.test.ts`
- Missing: Real boundary needs signed-in `sbx` and a guest agent, which the shell probe cannot drive; fail-closed/doctor covered.
- Last reviewed: 2026-11-17

### Removed providers (`srt`, `smolvm`)

- Surface: External dependency: sandboxing
- Status: `default`
- Evidence: `tests/local/sandbox.test.ts`
- Missing: Both fail with a migration message naming `nono`/`docker`.
- Last reviewed: 2026-11-17

### Sandbox grants for `injected/`, `state/`, `automations/`

- Surface: External dependency: sandboxing
- Status: `default`
- Evidence: `tests/local/sandbox-workspace-grants.test.ts` (filesystem grants: existing dirs writable, sibling denied, absent dir not granted); `tests/local/sandbox-workspace-grants-worker.test.ts` (nono worker: nested `worker add`, delegated task completes, automation write, denied `workspace.toml`/`.env`/`repos/`/outside writes; unsandboxed control)
- Missing: Other providers (`native`, `docker`) and `state/` writes other than the queue DB. Both suites skip when nono is not installed.
- Last reviewed: 2026-11-17

### `--sandbox <provider>`

- Surface: `devintern` command surface
- Status: `partial`
- Evidence: `tests/local/sandbox.test.ts` (per-provider fail-closed, removed srt/smolvm migration, native/goose rejection, unknown value)
- Missing: Real run per provider remains optional.
- Last reviewed: 2026-11-17

### `sandbox`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/sandbox.test.ts` (provider matrix, native auto, missing harness, invalid/unreachable, removed srt/smolvm)
- Missing: —
- Last reviewed: 2026-11-17

### Explicit provider in a worker failover chain skips a fallback entry it cannot wrap

- Surface: External dependency: sandboxing
- Status: `default`
- Evidence: `tests/local/sandbox-harness-chain-worker.test.ts` (real `devintern worker`, `AGENT_SANDBOX=native`, `AGENT_HARNESS=claude-code,opencode`, usage-limited claude-code stub, recording opencode stub); run with `bun run --filter @devintern/e2e test`
- Missing: The same rule for `docker` and for a fallback that becomes unwrappable after startup. The worker spawns the primary stub once at startup as a readiness probe under the sandbox; the test only requires at least one primary spawn.
- Last reviewed: 2026-11-27

### One-shot task run with a chain uses only the first entry under an explicit provider

- Surface: External dependency: sandboxing
- Status: `default`
- Evidence: `tests/local/sandbox.test.ts` ("a one-shot run with a chain fails closed on a first entry native cannot wrap"); run with `bun run --filter @devintern/e2e test`
- Missing: PR-review and interactive runs with a chain. Observed (unconfirmed intent): before the sandbox check fails closed, the one-shot run executes the first entry's CLI once with `--version` (version detection) outside any sandbox. No agent argv reaches it, and the test leaves that probe unasserted.
- Last reviewed: 2026-11-27

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 12: Sandbox providers `native`, `nono`, and `docker`, removed-provider (`srt`, `smolvm`) migration errors, plus invalid-provider and missing-binary fail-closed paths.

## Test notes

### Sandbox checks (nono, native, docker, removed providers)

The ordinary local suite exercises sandbox provider selection and the
fail-closed guarantee deterministically, plus the real nono boundary when nono
is installed. A deterministic shell agent reports what it could write and read,
so no AI account is needed.

The fail-closed and doctor checks always run against the built CLI. A provider
that is explicitly requested but cannot be enforced must abort before the
agent edits or pushes anything — never silently fall back to an unsandboxed
run:

| Provider | Default-offline check                                               | Optional real boundary                              |
| -------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| `nono`   | Removed from `PATH`; exits non-zero, no probe, no commit.           | Runs when installed, with `HOME` outside `/tmp`.    |
| `docker` | `sbx ls` shadowed to fail (unreachable daemon); exits non-zero.     | Not runnable with the shell probe (see below).      |
| `native` | Unsupported harness (`goose`) with a stub `goose`; exits non-zero.  | Needs a real claude-code/codex account, so not run. |
| `auto`   | Picks `native` for a native-capable harness and `nono` for `goose`. | —                                                   |
| invalid  | `--sandbox bogus` and `AGENT_SANDBOX=bogus` both exit non-zero.     | —                                                   |
| removed  | `--sandbox srt` / `smolvm` and `AGENT_SANDBOX` forms exit non-zero. | —                                                   |

The same suite covers the `devintern sandbox` doctor for non-nono providers:
native as the next run for claude-code/codex, docker refusing to claim a
sandboxed run when `sbx` cannot list its daemon, a missing harness CLI surfacing
as a preflight failure with the `*_CLI_PATH` fix, and the removed `srt`/`smolvm`
providers reporting a migration error instead of an unknown-provider list.

`tests/local/sandbox-workspace-grants.test.ts` proves the workspace-owned grants a
sandboxed agent needs outside the checkout: writes to an existing
`<workspace>/injected/`, `<workspace>/state/`, and `<workspace>/automations/`
succeed, a non-granted sibling under the workspace stays denied, and an absent
directory is neither granted nor created implicitly. The fixture root lives
outside the OS temp dir because nono's Linux profile already grants write on
`/tmp` itself; a workspace under `/tmp` would make the grant assertion pass
without exercising the explicit policy. The fixture also keeps the workspace
outside its root: `TMPDIR` lives under the root, and the macOS default policy
grants `dirname(TMPDIR)` (the per-user temp/cache parent), so a workspace inside
the root would be writable on the default temp grant alone. `SandboxWorkspace`
asserts that no default writable path covers the workspace before each run.

This test exercises the filesystem grants directly. It does not invoke
`devintern worker add` or a scheduled automation; those command paths under
nono are covered by `tests/local/sandbox-workspace-grants-worker.test.ts`
(below).

Docker Sandboxes (`sbx`) stays optional. Its real-boundary test skips unless the
prerequisite below is present; the fail-closed test still runs by shadowing the
executable. `sbx` only runs agents pre-installed in its guest microVM and
ignores the host executable path, so the deterministic shell probe cannot
exercise its boundary; its coverage here is selection, doctor reporting, and
fail-closed behavior.

#### Optional real-provider prerequisites

- **nono**: `nono` on `PATH` (`nono --version` succeeds). Every real-nono
  boundary test, including the workspace grants, reports an explicit skip when
  nono is absent instead of falling back to an unsandboxed run.
- **Docker Sandboxes**: the `sbx` CLI signed in (`sbx login`) with a reachable
  daemon; `sbx ls` must succeed.

Removed providers (`srt`, `smolvm`) have no prerequisite and no boundary test:
the suite only asserts that selecting either one fails with a migration message
naming `nono` or `docker`.

The sandbox suite keeps the nono isolated `HOME` outside the OS temp directory:
nono's Linux profile grants a broad read on `/tmp`, and a home nested under
that grant makes nono refuse its own per-user deny rules. Real user homes are
normally outside `/tmp`, so the fixture mirrors that. Other providers use a
workspace-local isolated home.

#### Workspace grants under nono (`worker add`, automations)

`tests/local/sandbox-workspace-grants-worker.test.ts` runs the real built `devintern
worker` with `AGENT_SANDBOX=nono` and the deterministic fake agent. A prompt
marker (`E2ESANDBOXDELEGATE`) makes the sandboxed agent call the built CLI's
`worker add --repo --title --body --idempotency-key --json` against the same
workspace, the devintern-delegate skill's path. The test asserts the nested
enqueue exits 0, writes its prompt under `<workspace>/injected/` and its row in
`<workspace>/state/queue.db`, and that the worker then completes the delegated
task. In the same run the agent tries to write `workspace.toml`, `.env`, a file
directly under `repos/`, and a directory outside the workspace. Every one of
those writes must fail and leave the files unchanged. A scheduled automation
(marker `E2ESANDBOXAUTOMATIONWRITE`) then writes under `automations/<id>/`.
Nothing pre-creates `injected/`, `automations/` or `state/`. The worker creates
the first two at startup and the queue creates `state/`, which matters because
the grant lists only existing paths.

A second test runs the same probes with `AGENT_SANDBOX=none` and asserts that
the forbidden writes succeed there. That proves the nono denials are real and
not a fixture artifact. The nono test skips with a named reason when nono or
the built CLI is missing; the unsandboxed control needs only the built CLI.

Fixture layout notes. The whole fixture root (workspace plus `HOME`) lives
outside `/tmp`, because nono's Linux profile grants write on `/tmp`; if no
base outside the temp dir is creatable, the nono test fails with that reason
instead of a misleading denial assertion. `TMPDIR` is `<root>/tmp/T`, two levels
down, because the default policy grants the temp dir on Linux and its parent on
macOS (the `/var/folders/<x>/<hash>` dir above `T`); a shallower `TMPDIR` would
put the workspace under that grant. The test asserts no default grant contains
the workspace. The agent, the Bun runtime, the CLI bundle and the workspace are reachable
as top-level `$HOME` entries, the way a real install keeps them under `$HOME`.
nono's policy grants read on those entries and never write. The `repos/`
probe writes directly under `repos/` because the repo's own bare clone is the
task worktree's git common dir, which the default policy grants so `git
commit` works.

```sh
bun run --filter @getdevintern/code build
bun test packages/e2e/tests/local/sandbox-workspace-grants.test.ts packages/e2e/tests/local/sandbox-workspace-grants-worker.test.ts
```

### Sandbox providers across an `AGENT_HARNESS` failover chain

These tests cover the documented chain rules: `auto` decides per harness, a
worker skips a fallback the explicit provider cannot wrap, and interactive
(one-shot) runs use only the first entry. Every harness CLI is a local stub, so
no agent account or model call is involved.

| Test                                                                                      | File                                               | Proves                                                                                                                                                                                                                                                                                                                       | Prerequisite                     |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| sandbox doctor decides auto per chain entry and warns when no provider wraps the fallback | `tests/local/sandbox.test.ts`                      | With `AGENT_SANDBOX=auto`, `AGENT_HARNESS=claude-code,opencode` and nono removed from `PATH`, the doctor prints a per-harness "Next run": native for claude-code, an explicit unsandboxed warning for opencode. A ready stub `sbx` is never picked.                                                                          | built CLI only                   |
| sandbox doctor picks native for claude-code and nono for opencode in an auto chain        | `tests/local/sandbox.test.ts`                      | Same chain with nono installed: native for claude-code, nono for opencode, docker never picked.                                                                                                                                                                                                                              | nono on `PATH` (skips otherwise) |
| an explicit native provider skips an opencode fallback it cannot wrap in a worker chain   | `tests/local/sandbox-harness-chain-worker.test.ts` | A real worker with `AGENT_SANDBOX=native` drops opencode at startup. When the claude-code stub hits a usage limit, the task is requeued with one `deferred` run, the claude-code window is persisted, nothing is pushed, and the opencode stub is never spawned (checked through its invocation log and the queue database). | built CLI only                   |
| a one-shot run with a chain fails closed on a first entry native cannot wrap              | `tests/local/sandbox.test.ts`                      | `devintern <task.md> --sandbox native` with `AGENT_HARNESS=opencode,claude-code` (no `--create-pr`) exits non-zero with the provider/harness error. The claude-code stub is never spawned, opencode never receives an agent argv, and the repo is unchanged.                                                                 | built CLI only                   |

The one-shot test does not pass `--agent-path`, so each harness resolves its
own recording stub through `<HARNESS>_CLI_PATH`. With `--agent-path` the probe
agent would also answer the CLI's `--version` detection and edit the repo
before the sandbox check runs.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```
