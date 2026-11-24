# Dashboard e2e coverage

Scope: the standalone `devintern dashboard` server and API, the worker-embedded dashboard, automation Run now, the Host/Origin guard, and log readback.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Dashboard standalone server/API and run history

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `default`
- Evidence: `tests/local/dashboard-api.test.ts` (read API and a worker-consumed ad-hoc retry); `tests/local/dashboard-embedded.test.ts` (Host/Origin guard with `--allow-origin` and `DASHBOARD_ALLOWED_ORIGINS`) (`bun run --filter @devintern/e2e test`)
- Missing: Run-now or retry for an automation with `open_pr = true` (a bare local remote has no code host to open the PR on).
- Last reviewed: 2026-11-20

### Worker/dashboard logs and artifacts

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `default`
- Evidence: `tests/local/dashboard-embedded.test.ts` (`GET /api/logs` readback and secret redaction); `tests/local/dashboard-artifacts.test.ts` (artifact list, content and `/file` download, harness-log content, redaction, 4xx refusals, and `devintern worker runs artifacts|logs --json` parity) (`bun run --filter @devintern/e2e test`)
- Missing: Binary/image artifact previews, Markdown artifact reference resolution, and truncation of oversized artifacts or logs.
- Last reviewed: 2026-11-18

### `dashboard`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/dashboard-api.test.ts`, `tests/local/dashboard-embedded.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: `--workspace` mode's read-only workspace automation catalog.
- Last reviewed: 2026-11-19

### Dashboard embedded in the worker

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/dashboard-embedded.test.ts`; `tests/local/dashboard-embedded-retry.test.ts` (ad-hoc retry re-queued through the worker's own queue, concurrent double-POST, Host/Origin guard on the retry route, audit and eligibility); `tests/local/dashboard-schedule-mode-tracker-retry.test.ts` (a failed polled offline-Jira run retried in schedule mode: one `scheduled_retries` row drained by the worker's retry queue, one re-run, one transition and comment per attempt, no extra run on later poll ticks) (`bun run --filter @devintern/e2e test`)
- Missing: A schedule-mode retry for a multi-team workspace (the persisted `team` pin) and a retry the drain defers because the repo is busy.
- Last reviewed: 2026-11-20

### GET /api/workspace redacted workspace view

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `default`
- Evidence: `tests/local/dashboard-artifacts.test.ts` (repos, shared `.env`, syntax/validation/missing states); `tests/local/dashboard-workspace-sync.test.ts` (teams with inline env and `env_file`, `[[error_monitors]]` with `base_url` userinfo, `[error_monitors.env]` and `env_file`, a masked TOML syntax error) (`bun run --filter @devintern/e2e test`)
- Last reviewed: 2026-11-23

### GET /api/workspace configSync against a running worker

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/dashboard-workspace-sync.test.ts` (worker-embedded dashboard: `applied` at startup, `applied` with a newer `appliedAt` after a hot reload, `rejected` for a startup-only `[[error_monitors]]` addition and for an invalid edit quoting a secret, with `rejectedReason` masked) (`bun run --filter @devintern/e2e test`)
- Missing: The `unconfirmed` state (needs a worker without an applied-config record) and asserting a transient `pending` (timing-dependent, deliberately not asserted).
- Last reviewed: 2026-11-23

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- ~~Priority 10: Retry through the worker-embedded dashboard. Embedded mode, embedded run-now, the Host/Origin guard, and log redaction are covered by `tests/local/dashboard-embedded.test.ts`; the standalone server, its read API, and a successful ad-hoc retry by `tests/local/dashboard-api.test.ts`.~~ Done: `tests/local/dashboard-embedded-retry.test.ts`.

## Test notes

### Standalone dashboard API

`tests/local/dashboard-api.test.ts` starts the built CLI as `devintern dashboard`
against a real `WorkerFixture` workspace, after the worker has drained one
injected task. The fixture picks a free port on the requested loopback host,
builds the health URL from that same host (bracketing IPv6 literals, so
`--host ::1` polls `http://[::1]:<port>`), and stops the process with SIGTERM in
`finally`; it never waits on a fixed timer and never binds a non-loopback
interface. The worker fixture's temporary HOME, workspace, output and queue
database are the only inputs, so no account, license, tracker, or network is
involved.

The suite asserts the read surface over that real run: health; the `/api/runs`
list with id, status, origin, task key and timestamps plus a bounded `limit`
(and the 400 for an invalid one); run detail with stages, retry eligibility,
harness-log and artifact arrays; the harness-log and artifact list routes; task
activity; empty agent-PR and automation catalogs; worker status; the worker log
tail including the daemon's captured startup banner; the documented 404 for an
unknown run id; stats with at least one succeeded run; and the 405
`{ error: "method not allowed" }` response for a non-GET `/api/runs`.
It also proves the daemon lock is observed as `running`, then stops the worker
and asserts the standalone dashboard reports `stopped` or `unknown` instead of a
phantom live worker. The write-route refusal paths are covered without side
effects: retrying the succeeded run returns 409 "not retriable: this run already
succeeded" before any spawn, a non-integer retry id returns 400, and an unknown
automation id returns 404. A separate case starts the CLI with `--host 0.0.0.0`,
asserts a non-zero exit with the loopback error, no "Dashboard running" line,
and that the chosen port is still free afterwards; another starts the fixture
with `--host ::1` (skipped only when the host cannot bind IPv6 loopback) and
asserts the bracketed health URL answers.

The same file also retries a real failed ad-hoc run. The deterministic agent
exits once before editing (`E2E_FAIL_ONCE_FILE`), so the shared fixture and the
base branch stay at the seeded greeting. After that run is `failed` and eligible
(`kind: "injected"`), two near-concurrent `POST /api/runs/:id/retry` requests
hit the running dashboard. Exactly one returns 202 `{ status: "scheduled",
runId, taskKey }` and writes one `run_retry_audit` row (`action: "scheduled"`,
actor `local-dashboard`); the other returns 409 with the documented in-flight
rejection. The row goes back to `pending`/`running` in `injected_tasks` and
`scheduled_retries` stays empty. The still-running worker drains that row once.
The suite then asserts the durable records: the original run stays `failed`
(attempt 1, nothing pushed), the new run is `succeeded` (attempt 2) on
`feature/<task-key>-attempt-2`, and that branch's only change is
`src/greeting.ts` exporting `Hello, world!`. No account, license, tracker, or
network is involved. Prerequisites are the built CLI and a local bare Git
remote, both created by the fixture:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

Worker-embedded dashboard mode, automation "Run now", the Host/Origin guard,
and log redaction are covered by `tests/local/dashboard-embedded.test.ts`
(below).

### Worker-embedded dashboard, Run now, and the Host/Origin guard

`tests/local/dashboard-embedded.test.ts` runs in the default offline suite. Its
first case starts a `WorkerFixture` with `dashboard: { port }`, which writes
`[workspace].dashboard = true`, `dashboard_port` (a free `127.0.0.1` port), and
a `[dashboard]` table with one `allowed_origins` entry and
`tailscale_autodetect = false`; the isolated environment also sets
`DASHBOARD_TAILSCALE_AUTODETECT=0`, so the host's `tailscale` state never
widens trust. One `[[automations]]` entry uses a January 1st cron, so it never
fires by itself. The case asserts:

- the embedded server answers `/api/health`, `/api/worker` (the daemon's pid,
  `running`), and `/api/automations` (the configured entry, its far-future next
  occurrence, no last run);
- rejected requests: a foreign `Origin`, a rebound `Host:
attacker.example:<port>` (on writes and on a GET), an allowlisted origin with
  a foreign Host, an allowlisted Host with a foreign Origin, and a missing
  Origin all return 403 with the documented error; a loopback Origin with
  `text/plain` returns 415. None of them creates a run, an occurrence file, or
  an agent invocation;
- the allowlisted origin with its own Host reads (200) and reaches the write
  route (404 for an unknown automation id);
- `POST /api/automations/<id>/run` with the loopback Origin returns 202
  `{ status: "triggered" }` and runs the automation once through the pipeline
  with the deterministic agent (held for 4s by `E2E_AGENT_DELAY_MS`). A second
  trigger while it runs returns 409, either the scheduler's "already running"
  or the dashboard's "already has a run in progress" refusal. The run record
  has origin `manual` and the automation id, and appears in
  `/api/runs?automationId=…`, `/api/runs?origin=manual`, and as the
  automation's `lastRun`;
- `GET /api/logs` returns the daemon's banner and its "starting manual run
  (dashboard)" line. A live edit to `workspace.toml` that the worker rejects
  echoes two seeded fake values (a `ghp_`-shaped token and an
  `E2E_API_TOKEN=…` assignment) into the raw daemon output; the dashboard log
  view shows them as `[redacted]`, and neither raw value nor its URL-encoded
  form appears in the response. The worker keeps its previous config.

The second case starts the standalone `devintern dashboard` with
`--allow-origin https://flag.e2e.example`, `DASHBOARD_ALLOWED_ORIGINS=
https://env.e2e.example:8443`, and `--no-tailscale-autodetect` against an
unstarted worker workspace. Writes go to `POST /api/tasks`, so each accepted
write is an `injected_tasks` row and each rejected one is not. Foreign Origin,
rebound Host, an allowlisted origin with a foreign Host or the wrong port, and
another loopback port's Origin are all refused with 403 and leave the queue
empty. Both allowlisted origins (with their own Host) and the loopback Origin
enqueue one row each with actor `local:dashboard`.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
# or just this file
cd packages/e2e && bun test tests/local/dashboard-embedded.test.ts
```

### Retry through the worker-embedded dashboard

`tests/local/dashboard-embedded-retry.test.ts` runs in the default offline
suite. It starts a `WorkerFixture` with `dashboard: { port }` and one injected
task that the deterministic agent fails once before editing
(`E2E_FAIL_ONCE_FILE`), then drives the retry through the worker's own
dashboard port, with no standalone `devintern dashboard`. It asserts:

- the failed run is eligible (`kind: "injected"`); a retry POST with no Origin,
  a foreign Origin, or a rebound Host returns 403, and `text/plain` returns 415.
  None of them re-queues the row or writes an audit entry;
- two concurrent `POST /api/runs/:id/retry` requests with the loopback Origin:
  one returns 202 `{ status: "scheduled", runId, taskKey }` with no `pid` or
  `command` (nothing was spawned), the other 409 with the documented in-flight
  refusal. There is one `run_retry_audit` row (`scheduled`, actor
  `local-dashboard`) and no `scheduled_retries` row;
- the same daemon completes the re-queued row: attempt 2 `succeeded` on
  `feature/<task-key>-attempt-2` with the greeting edit on the remote, nothing
  pushed for the failed attempt, and the base branch and seed unchanged;
- `GET /api/runs/:id` afterwards reports the success as not retriable ("this
  run already succeeded") and keeps the single audit entry on the failed run.

### Schedule-mode tracker retry through the embedded dashboard

`tests/local/dashboard-schedule-mode-tracker-retry.test.ts` runs in the default
offline suite. It starts a `WorkerFixture` with the embedded dashboard,
`tracker = "jira"` against the offline fake Jira, a `task_query`, 1 s polling,
and `WORKER_RETRY_INTERVAL_SECONDS=1`. The deterministic agent fails the first
run once (`E2E_FAIL_ONCE_FILE`). It asserts:

- the polled run is `failed`; the ticket was moved to In Progress and back to
  To Do, has one failure comment, and three more poll ticks start no run;
- two concurrent retries through the worker's dashboard: one returns 202
  `{ status: "scheduled", runId, taskKey }`, the other 409 (`a retry of <key> is
already scheduled or running`, or the in-progress refusal if the drain
  already started). One audit row (`scheduled`, `local-dashboard`, `queued for
the worker`) and one `scheduled_retries` row;
- the worker's retry queue logs one `re-running <key>`, settles the row
  `done`, and records attempt 2 `succeeded` on `feature/<key>-attempt-2` with
  the greeting edit on the remote;
- three later poll ticks skip the ticket as already actioned. The fake Jira
  saw exactly three transitions (In Progress, To Do, In Progress), one failure
  comment and one implementation comment, and no unexpected request;
- retrying the succeeded run returns 409 "this run already succeeded".

The fake Jira records accepted transitions (`FakeJiraTracker.transitions`)
so the test counts them instead of reading only the final status.

```sh
bun run --filter @getdevintern/code build
cd packages/e2e && bun test tests/local/dashboard-schedule-mode-tracker-retry.test.ts
```

### Run artifact and harness-log readback, and the redacted workspace view

`tests/local/dashboard-artifacts.test.ts` runs in the default offline suite and
needs only the built CLI (the existing `dist/` skip guard is the only skip).

The first case drains one injected task through a `WorkerFixture` whose
`[defaults].pipeline_file` adds a `verify` step (`implement → commit → verify →
finalize`). The verify prompt carries `E2EVERIFYVERDICT`, which makes the
deterministic agent (`helpers/fake-agent.ts`, `verify` mode) print an approving
JSON verdict. The worker env sets `E2E_AGENT_LEAK_TOKEN` to a fake `ghp_`-shaped
value; the agent echoes it to stdout (the raw harness transcript) and into an
extra verdict field that the product persists in the `verify-feedback.json`
artifact, once bare and once as `E2E_API_TOKEN=<value>`. Product redaction is
pattern-based (token shapes and credential-named keys), not env-based. The
secret is kept out of the verdict summary and items because run stages are
served unredacted. Through the standalone dashboard the case asserts:

- `GET /api/runs/:id/artifacts` lists the `verification` (JSON) and
  `verification-prompt` (text) artifacts for the run;
- `GET /api/runs/:id/artifacts/:artifactId` keeps the verdict's non-secret
  fields and shows the echoed note as `token [redacted] and
E2E_API_TOKEN=[redacted]`; the `/file` download returns the same sanitized
  bytes as an `application/octet-stream` attachment with `nosniff`;
- every `GET /api/runs/:id/harness-logs/:name` body is free of the token, and
  the verify turn's transcript shows the same `[redacted]` placeholders;
- none of these responses contains the raw or URL-encoded token;
- an unknown artifact id (content and `/file`) and an unknown log name return
  404; a non-integer run id returns 400 `run id must be an integer` on the
  artifact and harness-log routes (404 `not found` on `/file`, whose route only
  matches integer ids);
- `devintern worker runs artifacts <id> <artifact-id> --json` and `devintern
worker runs logs <id> <name> --json` print bodies equal to the HTTP ones.

The second case starts the standalone dashboard against a hand-written
`workspace.toml`: one repo with fake credentials in its remote
(`https://e2e-user:<fake>@git.e2e.invalid/...`), an `env_file`, a `[repos.env]`
table with a `ghp_`-shaped value, and a shared workspace `.env`. `GET
/api/workspace` returns `status: "ok"` with the repo structure, the remote
without userinfo, and env files and tables reduced to sorted key names. No env
value (secret or not) appears in the body. The same file is then rewritten as a
TOML syntax error with an unquoted token (`status: "invalid"`, `Failed to
parse ...`, value masked), as a validation error next to a credentialed remote
(`Invalid ...` with the problem list), and removed (`status: "missing"`). Each
response is 200 and never contains any seeded secret. The Host/Origin guard is
covered by `dashboard-embedded.test.ts` and is not repeated here.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
# or just this file
cd packages/e2e && bun test tests/local/dashboard-artifacts.test.ts
```

### Teams and error-monitor redaction, and configSync against a running worker

`tests/local/dashboard-workspace-sync.test.ts` runs in the default offline
suite and needs only the built CLI (the `dist/` skip guard is the only skip).
Every credential is a random fake per run, checked in raw, URL-encoded, and
base64 form (and base64 `user:password`, as a Basic auth header would carry
it); failure messages name the secret's index, never its value.

The first case starts the standalone `devintern dashboard` against a
hand-written `workspace.toml` (the worker is never started): two `[[teams]]`
(`alpha` with an inline `[teams.env]` token, `beta` with an `env_file`), a repo
with a `[repos.env]` token and an `https://user:<fake>@…` remote, and an
`[[error_monitors]]` Sentry entry whose `base_url` embeds `user:<fake>@` on an
unused loopback port (the standalone dashboard never polls monitors) plus
`[error_monitors.env]` and an `env_file`. `GET /api/workspace` returns
`status: "ok"`, no `configSync` (no running worker), teams and the monitor
with their names, trackers, queries and sorted env key names, the repo remote
and monitor `baseUrl` without userinfo but with scheme, host, port and path,
and no env value or userinfo name anywhere. A TOML syntax error with an
unquoted token in `[teams.env]` then returns 200 `status: "invalid"`,
`Failed to parse …`, with the token masked.

The second case starts a `WorkerFixture` with the embedded dashboard and one
never-due automation, and polls the worker's own `/api/workspace` (100 ms
interval, bounded deadline; no fixed sleeps):

- startup: `configSync: "applied"` with `appliedConfig.appliedAt`;
- appending an automation (hot-reloadable): `applied` again with a newer
  `appliedAt`, and the new automation in the view;
- adding a credentialed `[[error_monitors]]` (startup-only): `rejected` with
  `rejectedReason` "[[error_monitors]] is startup-only; …", the config view
  still `ok` with the monitor's `baseUrl` stripped, and no monitor secret
  anywhere in the body;
- an automation whose `repo` is a token-shaped value: `rejected` with
  `rejectedReason` containing `.repo "…" does not match any [[repos]] name.`
  while the worker's own stderr carries the raw value. The applied file version
  is unchanged and `/api/automations` still lists only the applied entries.
  The dashboard's own `invalid` load masks the value in `problems` too, and
  the secret scan covers the whole body.

The fixture's temporary root (HOME, workspace, queue database, bare remote) is
removed in `finally`, and the daemon is stopped there too.

```sh
bun run --filter @getdevintern/code build
cd packages/e2e && bun test tests/local/dashboard-workspace-sync.test.ts
```
