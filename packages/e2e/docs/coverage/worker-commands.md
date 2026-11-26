# `devintern worker` subcommand e2e coverage

Scope: worker setup and control subcommands: `worker init`, `login`, `scaffold`, `add-repo`, `add` (including `--after` dependencies), `cancel`, `connect` (validation and Sentry), and `run-now`. Relay `connect` targets live in [relay.md](relay.md).

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
- Status: `default`
- Evidence: `tests/local/worker-init-noninteractive.test.ts`: `--non-interactive` Markdown happy path with a stub agent CLI (exit 0, one `devintern.worker-init` v1 JSON document, `result: "success"`, mode-0600 `.env`, `[defaults].tracker`/`task_query` and one `[[repos]]` entry for the local bare `origin`; a follow-up `worker doctor` reports the same tracker, query, repository, and harness checks), text mode, 0 matches as a `query` warning, no agent CLI on PATH as a `harness` failure with exit 1, input errors that write nothing and exit 1 with one `❌` line (missing flags in text and JSON, `--jira-token`, unsupported tracker, a 0644 `--env-file`, `--repo-from-cwd` outside Git and without `origin`, `--yes`/`--tracker` without `--non-interactive`), an existing workspace refused without `--yes` (bytes unchanged) and `--yes` changing only `task_query`, three concurrent runs with exactly one writer and one repo entry, plain `worker init` with no TTY pointing to `--non-interactive`, and `--env-file` secrets absent from stdout and stderr. `tests/local/worker-init-wizard.test.ts`: the interactive wizard on a Bun PTY, Markdown path through every prompt declining sign-in, relay, Sentry, and the service, and Ctrl+D and Ctrl+C at the first prompt and at the mid-flow query prompt (one clean line, non-zero exit, no stack trace; nothing written at the first prompt). `tests/docker/worker-init.test.ts`: the same non-interactive scenarios on a blank Debian container with the packed CLI installed globally (`bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test` and `test:docker`)
- Missing: Trackers other than Markdown (credential probes need fake Jira/GitHub/Trello servers wired into init); the wizard's non-Markdown tracker prompts, a GitHub remote's App step, and a "yes" to the service. Known bugs tracked as `test.todo` in both local files: a wrong Jira token accepted by the credential probe, the GitHub probe not checking `GITHUB_REPO` access, a short Trello board id rejected by search, Ctrl+C/Ctrl+D mid-flow leaving `tracker = "jira"` that blocks a re-run, a relative `./tasks` `MARKDOWN_TASKS_DIR` in the wizard, token prompts echoing secrets, Ctrl+C reported as "(Ctrl+D)", and a missing license being a warning in init but a failure in doctor.
- Last reviewed: 2026-11-26

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

### `worker add --after` and `Depends on:`: dependent waits, then runs after its dependency succeeds

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-add-dependencies.test.ts`: `--after` and `**Depends on**:` both store the dependency in `merged` mode; `worker queue --json` shows the dependents `waiting` on the running dependency; their runs start no earlier than its `finishedAt`; unknown and cross-repo `--after` keys exit non-zero and enqueue nothing; a stray `Depends on:` key warns and enqueues without a dependency (`bun run --filter @devintern/e2e test`)
- Missing: Stacked mode, `--stack`/`--wait-merge`, and merge waits against a real code host; dependency cycles.
- Last reviewed: 2026-11-21

### Ad-hoc dependent of a failed dependency is blocked, and `--resume` releases it

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-add-dependencies.test.ts`: a dependency failed through `E2E_FAIL_PROMPT_MARKER` leaves its `--after` dependent `blocked` (reason names it) with no run while a later task completes; `worker add --resume` on the dependency, once it succeeds, starts the dependent (`bun run --filter @devintern/e2e test`)
- Missing: Escalated, abandoned, and PR-closed dependencies.
- Last reviewed: 2026-11-21

### `worker cancel`: withdraw a pending ad-hoc task

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-cancel.test.ts`: `cancelled`, `already_cancelled` (first reason kept), and `not_found` outcomes and exit codes; the task moves to `cancelled` in `worker queue --json` and never runs; a background `worker add --wait --json` exits 3 with `status: "cancelled"`; a running task returns `already_started`, exit 1, and completes; an `--after` dependent of a cancelled task is `blocked` (`bun run --filter @devintern/e2e test`)
- Missing: — (the dashboard **Cancel task** action and the `--resume` refusal have their own rows below).
- Last reviewed: 2026-11-22

### Dashboard Cancel task (`POST /api/tasks/:id/cancel`): withdraw a pending ad-hoc task

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-cancel.test.ts` ("dashboard Cancel task …"), against a standalone `devintern dashboard` on the same workspace: by task key with `{ "reason": "e2e" }`, 200 `cancelled`, a background `worker add --wait --json` exits 3 with `status: "cancelled"`, and `worker queue --json` lists it as cancelled by `dashboard` with the reason; by numeric row id, 200 with the task key; a repeat returns 200 `already_cancelled`, an unknown key 404 `not_found`, a running task 409 `already_started` (it still succeeds), and a finished task 409 `already_finished`; a POST without the Origin/Content-Type guard headers (403), a numeric reason, and a 501-character reason (400) leave the row pending; after a later task completes, the cancelled tasks have no run and no branch on the bare remote (`bun run --filter @devintern/e2e test`)
- Missing: The dashboard UI button itself (the test calls the API the button uses); an empty-body or malformed-JSON POST.
- Last reviewed: 2026-11-22

### `worker add --resume` refuses a cancelled task

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-cancel.test.ts` ("dashboard Cancel task …"): `worker add --resume <key> --json` on each dashboard-cancelled task exits non-zero, prints nothing on stdout, and names the task with "a cancelled task cannot be resumed" on stderr; `worker queue --json` gains no pending row and still lists the task as cancelled with its original actor and reason (`bun run --filter @devintern/e2e test`)
- Missing: `--resume --wait` on a cancelled task; a task cancelled through the CLI (the refusal does not depend on the actor).
- Last reviewed: 2026-11-22

### Read-only worker commands (status, overview, stats, prs, automations, logs, runs) and --json parity with the dashboard API

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-read-commands.test.ts`: on a worker with the embedded dashboard, one succeeded ad-hoc run, a scheduled automation, and a `blocked` queued dependent, `--json` equals the matching route for `runs` (unfiltered and `--task-key`/`--limit`), `runs show|logs <id> [<name>]|artifacts <id>`, `stats --window all|7d`, `automations`, `prs` (open and `--state merged`), `queue`, `status`, `overview`, and `logs --lines N --level info|warn`; only `overview.generatedAt` is removed. After the worker stops, every command still exits 0 from the state database (run history kept, `status`/`overview` report `stopped`), and each human form exits 0 with output. A missing `--workspace` (all eight commands), an invalid `--window` (also 400 on `/api/stats`), an invalid `--level`, and an unknown run id exit 1 with the error on stderr. All HTTP(S) goes through a refusing recorder that sees zero requests (`bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`)
- Missing: Non-empty `prs` bodies (needs a code host that records agent PRs); `runs artifacts <id> <artifact-id>` with a registered artifact; `--origin`/`--status`/`--automation`/`--offset` filters; `stats --tz`; a read-only (sandbox-mounted) state directory.
- Last reviewed: 2026-11-23

### worker doctor: readiness pass and fail paths

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-doctor.test.ts`: a `WorkerFixture` workspace (local bare remote, deterministic agent, one automation) passes every check and exits 0 without creating the state database or lock; `--offline` turns the repository and license checks into warnings, exit 0; with licensing on and no `LICENSE_KEY` or session, **Automation entitlement** fails closed (exit 1, no network); a busy dashboard port is a warning; a missing `workspace.toml` (by `--workspace` and by default location), a nonexistent remote path (detail names git's `does not appear to be a git repository` cause), and unparseable TOML exit 1 with the failing check and its hint; `--json` is rejected as an unknown option (doctor has no JSON mode); a credential in the workspace `.env` never appears in output; zero requests reach the refusing proxy (`bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`)
- Missing: GitHub remotes checked through the API; a signed-in entitlement; harness and sandbox failures. (Tracker credential and task-query checks have their own row below.)
- Last reviewed: 2026-11-25

### worker doctor: tracker credentials and task-query dry run (`[defaults]`, `[[teams]]`)

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-doctor-trackers.test.ts` against `providers/fake-jira.ts`. `[defaults]` (Jira, credentials in the workspace `.env`): **Tracker credentials** passes and **Task query** reports `2 tasks match`, the fake records exactly the configured JQL once, exit 0. A query the fake rejects with 400 and Jira-style `errorMessages` exits 1 with the Jira error and the `Fix [defaults].task_query in workspace.toml` hint, after exactly one search. With `JIRA_API_TOKEN` absent, the credential row names the variable and the `.env` path, the dry run is `not run (missing tracker credentials)`, and no request reaches the fake. `[[teams]]`: two Jira teams on separate fakes (one via `env_file`, one via `[teams.env]`) both pass with their own JQL. A missing token or a rejected query fails only that team, labelled `jira (team "<name>")`, with the team hint (naming `env/alpha.env` when set). `--offline` still runs the local credential check (a missing token still exits 1) and turns each dry run into a `skipped (--offline)` warning with no fake request. Tokens never appear raw or URL-encoded in output; no state database or lock is created; the refusing proxy sees zero requests (`bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`)
- Missing: Trackers other than Jira; a dry-run timeout; namespaced team values in the workspace `.env` (`JIRA_<TEAM>_*`); live Jira `/search/jql` drift. Observed (unconfirmed intent): the **Work sources** detail pluralizes as `2 tracker querys` (not asserted).
- Last reviewed: 2026-11-25

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

### Worker ad-hoc task dependencies (`--after`, `Depends on:`)

`tests/local/worker-add-dependencies.test.ts` runs the built worker daemon
against a local bare remote with the deterministic fake agent. The workspace
omits `--create-pr`, so a dependency that succeeds without a PR satisfies
`merged` mode, the default for a repo without a code-host platform. State is
read only through `worker queue --json`, `worker runs --task-key … --json`, and
`worker runs show <id> --json`.

- A chain proves that `--after` and a `**Depends on**:` body line both hold a
  dependent `waiting` while its dependency runs (`E2E_AGENT_DELAY_MS` slows the
  agent), and that each dependent's run starts no earlier than the
  dependency's `finishedAt`.
- Validation, with no daemon: an unknown `--after` key and a key from another
  `[[repos]]` entry exit non-zero and leave the queue unchanged; a
  `Depends on:` line naming no ad-hoc task prints the `Ignoring 'Depends on:'`
  warning and enqueues without a dependency.
- A dependency failed with `E2E_FAIL_PROMPT_MARKER` blocks its dependent, which
  has no run while a later task completes. After the marker is removed,
  `worker add --resume` on the dependency succeeds and the dependent runs.

### Worker `worker cancel`

`tests/local/worker-cancel.test.ts` cancels a pending task with no worker
running, re-cancels it, cancels an unknown key, and checks that an `--after`
dependent of the cancelled task is `blocked`. With the daemon running a slow
task in the only slot, it cancels a second task that a background
`worker add --wait --json` is waiting on (the waiter exits 3 with
`status: "cancelled"`), confirms cancelling the running task exits 1 and that
task still succeeds, and runs a later task to completion to show no cancelled
or blocked task ever started.

A second test in the same file drives the dashboard **Cancel task** API
(`POST /api/tasks/:id/cancel`) on a standalone `devintern dashboard` bound to an
ephemeral loopback port against the same workspace. With no worker running, it
checks that a POST without the write-guard headers, a numeric reason, and a
501-character reason are rejected without changing the row, then cancels that
task by its numeric row id. With a slow task in the only slot, it gets 409
`already_started` for the running task, cancels a task a background
`worker add --wait --json` is waiting on (exit 3, `status: "cancelled"`), and
checks `already_cancelled`, `not_found`, and, once the slow task succeeds,
`already_finished`. `worker add --resume` on each cancelled task exits non-zero
with "a cancelled task cannot be resumed" and enqueues nothing. A later task
then completes, and the cancelled tasks have no run and no branch on the bare
remote. This test keeps the default `--create-pr` task args, so runs push to the
bare remote.

Prerequisites: the built CLI only (no tracker, code host, network, or
credentials). Each test uses its own temporary HOME, workspace, and queue
database, and stops the dashboard, the worker, and any background `--wait`
process in `finally`.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Worker read-only commands and dashboard API parity

`tests/local/worker-read-commands.test.ts` starts a `WorkerFixture` with the
embedded dashboard on an ephemeral `127.0.0.1` port and one never-due
`[[automations]]` entry. Before the daemon starts it enqueues one ad-hoc task
for the deterministic agent, cancels a second task, and adds a third `--after`
the cancelled one, so the queue keeps one `blocked` item without a slow agent.
Once the run succeeds, each read command's `--json` body is compared with its
`GET /api/...` route. The route is read before and after each CLI call, and the
comparison runs only when both reads agree, so a log line the idle worker writes
in between cannot cause a false mismatch. Only `overview.generatedAt` (the
handler's wall-clock time) is removed before comparing.

The worker is then stopped and the commands run again from the state database
alone: exit 0, valid JSON, the run still listed, `status` and `overview`
reporting `stopped`. Each human form exits 0 with non-empty output, and bad
`--workspace`, `--window`, `--level`, and run-id inputs exit 1 with their error.
The daemon and every CLI call get `HTTP(S)_PROXY` pointing at a refusing
recorder (loopback bypassed), which must see zero requests.

### Worker doctor

`tests/local/worker-doctor.test.ts` runs `devintern worker doctor` against a
prepared but never started `WorkerFixture` workspace: a local bare remote, the
deterministic agent through `AGENT_CLI_PATH`, and one automation. It asserts
the rendered check lines and exit codes for the ready path, `--offline`,
licensing turned on with no key or session (fails closed in the isolated HOME
with no request sent), a busy dashboard port, a missing `workspace.toml`, a
nonexistent remote path, unparseable TOML, and the rejected `--json`. It
rewrites `workspace.toml` between cases. A random fake `GITHUB_TOKEN` in the
workspace `.env` must not appear in stdout or stderr, raw or URL-encoded.

### Worker doctor tracker checks

`tests/local/worker-doctor-trackers.test.ts` runs `devintern worker doctor`
against a prepared, never started `WorkerFixture` workspace with
`[defaults].tracker = "jira"` and in-process `FakeJiraTracker` servers on
loopback. Jira credentials live only in the workspace `.env`, a team
`env_file`, or `[teams.env]`, with random fake tokens; the child environment
carries none.

- `[defaults].task_query`: the ready path reports the dry-run match count and
  the fake's `searches` equal the configured JQL. A query rejected through
  `FakeJiraTracker.rejectSearchesContaining` (400 with `errorMessages`, as Jira
  answers an unknown status) fails with the `[defaults].task_query` hint. A
  `.env` without `JIRA_API_TOKEN` fails the credential row, the dry run is not
  run, and the fake records no search.
- `[[teams]]`: two teams on two fakes pass independently. Breaking one team's
  credentials (in `[teams.env]`, then in its `env_file`) or query fails only
  that team, and the other team's dry run still runs.
- `--offline` keeps the local credential check and skips every dry run as a
  warning with no request.

Prerequisites for all three: the built CLI only (no real tracker, code host,
network, or credentials; the tracker suite uses loopback fake Jira servers).
Each test owns one temporary root (HOME, workspace, state database, bare
remote) and removes it in `finally` together with the daemon, the recording
proxy, the fake trackers, and any listener it bound.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Worker init (`worker init`, non-interactive and wizard)

`tests/local/worker-init-noninteractive.test.ts` runs the built CLI's
`devintern worker init --non-interactive` with stdin closed and no TTY. Each
test owns a temporary root (`helpers/worker-init.ts`): HOME, the workspace, a
Markdown task folder with one `status: todo` task, and a checkout whose
`origin` is a local bare repository, so the query and repository checks run
for real without a network. PATH is built from scratch (`git`, `which`, `bun`,
and a stub `claude` when the test wants an agent), so an agent CLI installed on
the host cannot change the harness verdict. Assertions read the `--json`
document and the files on disk rather than CLI prose, except for the one-line
input errors. Fake secrets (a `GITHUB_TOKEN` and a `LICENSE_KEY` in a 0600
`--env-file`) must reach the workspace `.env` and never stdout or stderr, raw
or URL-encoded, in JSON mode, text mode, or a follow-up `worker doctor`.

`tests/local/worker-init-wizard.test.ts` drives the interactive wizard on a Bun
pseudo-terminal (`Bun.spawn({ terminal })`) with no extra system packages.
Ctrl+D and Ctrl+C are sent as the raw bytes `\x04` and `\x03` through the PTY:
closing stdin, or `script` with `</dev/null`, never delivers EOF to the
wizard's raw-mode readline. Licensing is on with no key or session, so the
Worker Pilot sign-in prompt appears and is declined. HTTP(S) goes through a
refusing loopback proxy that must see zero requests. The PTY cases skip only
where Bun has no PTY support (Windows).

### Worker init blank-machine smoke (Docker)

`tests/docker/worker-init.test.ts` is opt-in because it needs a Docker daemon.
`bun run --filter @devintern/e2e test:docker` (scripts/docker.ts) packs the
built CLI with `bun pm pack`, builds `docker/worker-init/Dockerfile` (the
`oven/bun:<host Bun version>-debian` image, git only, a non-root user with the
host's uid, and the CLI installed with `bun add -g`), and runs the file. Each
test starts a fresh container with `--network none` and runs commands through
`docker exec` without `-i`/`-t` (no TTY, stdin closed), so the CLI sees a
first-time install: the default `~/.devintern`, no agent CLI, no session or
license, and none of the suite's skip flags. Scenarios: the Markdown happy path
with a stub agent (license as a warning plus a `sign-in` next step, doctor's
shared checks, re-run refusal, `--yes` changing only the query), no agent CLI,
0 matches, the input errors, no TTY, concurrent runs, and `--env-file`
redaction. The e2e-local workflow runs it after the local suite.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test:docker
```
