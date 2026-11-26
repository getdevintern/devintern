# Relay e2e coverage

Scope: the hosted relay: GitLab relay delivery, relay instant events, tracker `task.changed` delivery, and `worker connect` relay targets.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### GitLab relay: delivery, MR-close unwatch, `--disconnect`

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `live`
- Evidence: `tests/code/gitlab-relay.test.ts`
- Missing: GitHub relay delivery. Offline tracker `task.changed` delivery is covered in the worker surface (`tests/local/worker-relay-task-events.test.ts`).
- Last reviewed: 2026-11-17

### `worker connect` relay targets (`github`, `gitlab`, `linear`, `asana`, `trello`, `azure-devops`, `jira`, `status`)

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `gap`
- Evidence: `gitlab` only: `tests/code/gitlab-relay.test.ts` (`live`)
- Missing: Needs a signed-in relay session (`devintern worker login`); `status` exits "Not authenticated" without one, so there is no loopback-only path.
- Last reviewed: 2026-11-17

### Relay instant events

- Surface: `devintern worker` surface
- Status: `live`
- Evidence: GitLab relay suite (`tests/code/gitlab-relay.test.ts`)
- Missing: GitHub relay PR events (`pr.review_submitted`, `pr.comment_created`): the GitHub API base URL is hardcoded, so they cannot be faked offline. GitLab v2 `change.feedback`/`change.changed` events now also have offline coverage (see the next row).
- Last reviewed: 2026-11-24

### Relay v2 GitLab code-host events (offline): `change.feedback` and `change.changed` reconcile registered MRs; ignored envelopes do not pin the cursor

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-relay-gitlab-events.test.ts` (loopback relay + fake GitLab forge + local bare remote; `bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`)
- Missing: a relay hint that arrives while a poll tick is running (the reconcile is skipped by the poller's busy guard); real GitLab project hooks into the hosted relay (live suite only).
- Last reviewed: 2026-11-25

### Relay v2 GitLab `ci.changed` (offline): a failed pipeline on a registered MR's head runs CI repair once

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-relay-gitlab-events.test.ts` ("relayed v2 GitLab ci.changed runs CI repair once on a failed head; …"), same fixture as the row above with `[workspace].ci_failure_fix = true` and a `FakeGitlabCiFailure` on the MR head
- Missing: a pipeline with several failed jobs or `allow_failure` jobs; CI-repair retry budget and escalation after a failed repair; real GitLab pipeline hooks into the hosted relay (live suite only).
- Last reviewed: 2026-11-25

### Relay v2 GitLab `ci.changed` (offline): passing pipeline, stale head SHA, and redelivered `deliveryId` run nothing

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-relay-gitlab-events.test.ts` (same test as the row above: a `success` pipeline, then a `ci.changed` for the pre-repair SHA, then a replay of the failed envelope's `deliveryId`)
- Missing: a `running` pipeline (served by `FakeGitlabForge.setCiStatus` but not exercised); a stale SHA that still has a failed pipeline of its own. Note that the stale case passes because the worker always reads the MR's current head, not because it compares `ref.headSha`.
- Last reviewed: 2026-11-25

### Relay v2 GitLab `ref.headSha`-only envelopes (offline): `ci.changed` with no `change` or `branch` still runs CI repair

- Surface: `devintern worker` surface
- Status: `partial`
- Evidence: `tests/local/worker-relay-gitlab-events.test.ts` ("relayed v2 GitLab ci.changed identified only by ref.headSha …"): an envelope carrying only the MR's current head SHA resolves registered MR !1 and runs one CI repair
- Missing: Observed (unconfirmed intent), from `packages/code/src/lib/workspace/gitlab-fleet-events.ts` and not asserted: the relay matcher filters registered MRs by `change` and `branch` only and never compares `ref.headSha`, so a `headSha`-only envelope reconciles every open registered MR in the project, whatever SHA it names. `change.changed` with `headSha` only is not covered.
- Last reviewed: 2026-11-25

### Relay tracker `task.changed` delivery: query gate, cursor resume, `deliveryId` dedupe, outage backoff, bearer auth

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-relay-task-events.test.ts` (fake Linear + loopback relay; `bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test`)
- Missing: New `deliveryId` for an unchanged task and relay/poll-sweep dedupe (both need the post-PR actioned marker, and the bare remote opens no PR); real tracker webhooks into the hosted relay.
- Last reviewed: 2026-11-17

## Test notes

### Relay `task.changed` delivery (offline)

`tests/local/worker-relay-task-events.test.ts` starts one real
`devintern worker` with fake Linear (`providers/fake-linear.ts`) as the tracker
and a loopback relay fake (`helpers/fake-relay.ts`) in place of the hosted
control plane. No relay account, Supabase session, Linear workspace, or network
access is required, and `worker connect` is never run. The test writes a fake
pairing into `<workspace>/state/code/relay.json` (`relayUrl`, `customerId`, and
a synthetic `drt_e2e…` token) and points `WORKER_RELAY_URL` at the fake.

The fake implements `GET /v1/events?cursor=<n>`: it returns buffered envelopes
with a `seq` above the cursor, holds empty long polls for up to a second, and
can answer the next N polls with a scripted 5xx. Its request log keeps the
cursor and a bearer-token-matched boolean, never the header value.

`[defaults].task_query` is a Linear title filter and `poll_interval = 3600`, so
Mode 1 polling only runs its startup tick. That tick finishes before the
eligible issue exists, so the relay is what triggers the run. The test proves:

- a `task.changed` envelope for the eligible issue produces exactly one
  implementation run (pushed `feature/<key>` branch, Linear state moved to In
  Progress, one implementation comment), and an envelope for a decoy that does
  not match `task_query` produces no run, branch, comment, or state change;
- the cursor advances to the last `seq`, and replaying the same `deliveryId`
  under a new `seq` does not run the task again;
- after a graceful restart, the first poll carries the persisted cursor (never
  `0`). That poll gets a scripted 503: the worker logs the 5s backoff, keeps
  running, retries with the same cursor, and then consumes a later envelope;
- every poll carried the bearer token, and neither it nor the fake Linear key
  appears in worker output.

Linear workflow states are committed to the fixture repo's base branch as
`.devintern-code/settings.json`, because the task child reads settings from
its worktree.

Not covered: GitHub relay PR events (`pr.review_submitted`,
`pr.comment_created`); a new `deliveryId` for an unchanged task; and a later
poll sweep re-evaluating a task the relay already ran. Those last two rely on
the actioned marker, which is written only after a PR is created, and the local
bare remote exposes no code host.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Relay v2 GitLab code-host events (offline)

`tests/local/worker-relay-gitlab-events.test.ts` starts a real
`devintern worker` against the loopback relay fake (`helpers/fake-relay.ts`,
whose `publishCodeHostEvent` emits v2 envelopes with `codeHost` identity) and
the fake GitLab forge (`helpers/fake-gitlab-forge.ts`), fronted by
`helpers/gitlab-forge-proxy.ts`, which adds the project-membership lookup the
registered-MR poller uses to accept a reviewer. Git traffic to the forge URL is
rewritten onto a local bare repository. The relay pairing is seeded with
`helpers/relay-state.ts`, and the MR is registered directly in `agent_prs`.
`poll_interval = 3600` and the MR is registered only after the startup poll
tick, so only a relay envelope can start a job. The test proves:

- `change.feedback` for MR !1 starts address-review within 30 seconds: exactly
  one agent run whose prompt has the forge's reviewer comment, a new commit on
  the MR branch, one discussion reply, and the cursor advanced. Republishing
  the same `deliveryId` is skipped by relay dedupe before any forge request;
- a v1 envelope with `codeHost`, a `source`/`codeHost.provider` mismatch, a v2
  envelope with no `change`/`branch`/`headSha`, and v2 envelopes for an
  unregistered project or MR IID are acknowledged with no agent run and no
  forge request, and the valid envelope published after them still runs;
- `change.changed` for an MR whose branch conflicts with its target (with
  `[workspace].conflict_resolution = "auto"`) runs conflict resolution once:
  one push of the merged branch, after which it merges cleanly into the
  unchanged target. A second `change.changed` runs nothing;
- with `[workspace].ci_failure_fix = true` and the forge serving one pipeline
  and job for the MR head (`FakeGitlabCiFailure`), `ci.changed` (published
  with `FakeRelay.publishCiChanged`) while the pipeline passes reads the
  pipeline but no trace and runs nothing. After `FakeGitlabForge.setCiStatus`
  flips it to failed, the next `ci.changed` runs exactly one CI-repair agent
  whose prompt has the failed job name and trace, pushes one commit on top of
  the old head, and records a `ci_fix` run. A `ci.changed` for the pre-repair
  SHA reads only the new head's pipelines and runs nothing, and a replay of
  the failed envelope's `deliveryId` makes no forge request;
- a `ci.changed` that names the MR only by `ref.headSha` runs the same single
  CI repair;
- neither the relay token nor the forge token (raw or URL-encoded) appears in
  worker output or in any file under the fixture root.

Prerequisite: the built CLI only. No relay account, GitLab instance, or
network access is needed.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### GitLab relay (live)

The separate opt-in `test:e2e:gitlab-relay` suite uses the **deployed** relay.
It installs a real managed project hook, proves review feedback arrives with
normal polling effectively disabled, verifies MR-close unwatching, and checks
that `--disconnect` removes the managed hook and stops deliveries. It needs a
signed-in Supabase session (`E2E_RELAY_AUTH_SESSION`, or the local
`~/.devintern/state/code/.auth-session.json`), an entitled account, and the
local GitLab container. It writes a temporary hook and relay route, then removes
both in cleanup. Run it with:

```sh
bun run --filter @devintern/e2e test:e2e:gitlab-relay
```

CI must provide `E2E_RELAY_AUTH_SESSION` explicitly; the suite is not part of
PR CI.
