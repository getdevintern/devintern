# `devintern worker` subcommand e2e coverage

Scope: worker setup and control subcommands: `worker init`, `login`, `scaffold`, `add-repo`, `add`, `connect` (validation and Sentry), and `run-now`. Relay `connect` targets live in [relay.md](relay.md).

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### `worker connect` validation, `--help`, and `sentry`

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `default`
- Evidence: `tests/local/worker-connect.test.ts`: arg errors with no writes, non-TTY refusal, PTY happy path on `FakeSentryServer`, idempotent re-run, 401 fail-closed, repo resolution (`bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`)
- Missing: Live Sentry API drift.
- Last reviewed: 2026-11-17

### `worker init`

- Surface: `devintern worker` surface
- Status: `gap`
- Evidence: —
- Missing: Non-interactive failure and prompt-free path.
- Last reviewed: 2026-11-17

### `worker login`

- Surface: `devintern worker` surface
- Status: `gap`
- Evidence: —
- Missing: Session isolation from project login.
- Last reviewed: 2026-11-17

### `worker scaffold`

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-workspace-bootstrap.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: —
- Last reviewed: 2026-11-17

### `worker add-repo`

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-workspace-bootstrap.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: —
- Last reviewed: 2026-11-17

### `worker add`: `--title`, `--body`, `--json`

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `WorkerFixture.addTask`
- Missing: —
- Last reviewed: 2026-11-17

### `worker add`: `--body-file`, `--idempotency-key`, `--resume`, `--wait`, `--wait-timeout`, `--workspace`

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-add-options.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: —
- Last reviewed: 2026-11-17

### `worker connect`: validation and `sentry`

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-connect.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Relay targets: see external section.
- Last reviewed: 2026-11-17

### `worker connect`: relay targets

- Surface: `devintern worker` surface
- Status: `gap`
- Evidence: —
- Missing: Signed-in relay session; see external section.
- Last reviewed: 2026-11-17

### `worker run-now`

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-working-windows.test.ts`
- Missing: Additional scheduling scenarios.
- Last reviewed: 2026-11-17

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 7: `worker add` full option matrix (`--body-file`, idempotency, resume, wait, wait-timeout, workspace, validation and deduplication).
- Priority 8: `worker scaffold`, `add-repo`, `run-now`, and `connect status` in temp homes (`connect` validation and `connect sentry` are covered by `tests/local/worker-connect.test.ts`; `connect status` still needs a relay session).

## Test notes

### Worker `worker add` option matrix

The default local suite (`tests/local/worker-add-options.test.ts`) drives the built
CLI's `devintern worker add` through every documented option against a throwaway
workspace and a local bare Git remote seeded from `fixtures/simple-project`; no
tracker or hosted code host is involved. Enqueue-only cases cover `--title`,
`--body`, `--body-file <path>`, `--body-file -` stdin, `--idempotency-key`,
`--workspace`, `--json`, and the validation errors. Daemon cases cover `--wait`,
`--wait-timeout` (`0` and a bounded timeout through `E2E_AGENT_DELAY_MS`), and
`--resume`, asserting the pushed branch/commit directly on the bare remote rather
than a pull request.

### Worker workspace bootstrap (`worker scaffold` and `worker add-repo`)

The default local suite (`tests/local/worker-workspace-bootstrap.test.ts`) drives
the built CLI's non-interactive onboarding path in a temporary HOME and
workspace. It seeds a local bare Git remote and a checkout (no network, tracker,
or credentials), then asserts the on-disk result rather than CLI prose:

- `worker scaffold` writes `workspace.toml` and the shared `.env` with mode
  `0600`; a second run exits non-zero without changing either file.
- The generated TOML parses through a follow-up `worker add` invocation.
- `worker add-repo` derives a filesystem-safe `[[repos]]` name from the remote,
  does not pin a transient `origin/HEAD`, and seeds a `[[routing.rules]]` entry
  from `JIRA_DEFAULT_PROJECT_KEY` (or `LINEAR_DEFAULT_TEAM_KEY`).
- Missing repo env keys merge into the shared `.env`; conflicting values are
  demoted to the repo's inline `[repos.env]` instead of overwriting shared
  values.
- Re-running `add-repo` is idempotent, and running from a package subdirectory
  still resolves the repository-root `.devintern-code/.env`.
- A missing workspace or a checkout without an `origin` exits non-zero and
  writes nothing.

The temporary root (HOME, workspace, bare remote, and seed checkout) is removed
in `finally`; the run creates no resource outside it.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Worker connect validation and Sentry connect

`tests/local/worker-connect.test.ts` runs the built CLI's `devintern worker
connect` against a workspace bootstrapped with `worker scaffold` and
`worker add-repo`. `WORKER_RELAY_URL` and `DEVINTERN_API_BASE` point at a
loopback recorder, and every case asserts it received zero requests.

- Unsupported targets, `--team` with `status`/`sentry`, `--repo` with a
  non-Sentry target, `--disconnect` with a non-GitLab target, and a missing
  `--workspace` each exit 1 with their exact error. `workspace.toml`, `.env`,
  and `env/` stay byte-identical. `--help` lists every target.
- `connect sentry` with piped (non-TTY) stdin exits 1 and writes nothing.
- The interactive Sentry flow runs on a Bun pseudo-terminal
  (`Bun.spawn({ terminal })`) against `providers/fake-sentry.ts`. A valid token
  writes exactly one `[[error_monitors]]` entry and a mode-`0600` token file,
  and the token stays out of `workspace.toml`. A re-run with `SENTRY_AUTH_TOKEN`
  in the environment adds no duplicate. A token the fake rejects with 401
  writes nothing. An unknown `--repo` fails before any prompt, and in a
  two-repo workspace cwd's `origin` selects the repository.
- The token prompt is visible by design, so the PTY echoes the typed token once.
  The suite asserts it appears exactly once, right after its prompt, so the
  CLI's own log lines never repeat it.

PTY cases skip with a logged reason only where Bun has no pseudo-terminal
support (Windows). Relay targets need a signed-in relay session and stay out of
this offline suite.
