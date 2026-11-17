# Azure DevOps tracker e2e coverage

Scope: Azure DevOps Boards: the offline fake lifecycle and worker WIQL polling.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Azure DevOps: offline fake key/`--query`, state, comment, decoy

- Surface: External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-azure-devops-fake.test.ts`
- Missing: Live project lifecycle.
- Last reviewed: 2026-11-17

### Azure DevOps polling: `ChangedDate` day delta, exactly-once pickup, dedupe, re-arm, cursor restart

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-azure-devops-polling.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Live project; actioned-with-PR gate (no PR on a bare remote); WIQL time zone.
- Last reviewed: 2026-11-17

## Tracker plan status

### Azure DevOps

- Default `test`: yes (offline fake)
- Opt-in suite: none
- Notes: Fake lifecycle: key/`--query`, state transition, comment, decoy isolation. Worker polling (WIQL `ChangedDate` delta, dedupe, re-arm, cursor restart) is offline.
- Last reviewed: 2026-11-17

## Layer 3 fake (implemented)

`tests/local/worker-azure-devops-polling.test.ts` starts the built worker with
`tracker = "azure-devops"` and a ready-state WIQL `task_query` against the
Azure DevOps fake. The fake evaluates `>=`/`>`/`<=`/`<` on `System.ChangedDate`
and `System.CreatedDate` with day precision for `YYYY-MM-DD` literals (UTC),
records every WIQL request, and can stamp dates from the wall clock
(`realClock`). The test asserts the product's delta query text, exactly-once
pickup with branch, run record, comment, and state, over-reported same-day ticks
without duplicate work, re-arm when another item enters the ready state, and
resume from the persisted cursor after a graceful restart. A final phase runs
with `--skip-comments`, so the processed item keeps matching at the same
`ChangedDate` and the `(key, updated)` dedupe is the only guard against a
re-run.

## Test notes

### Azure DevOps fake endpoints

The Azure DevOps fake covers
project-scoped WIQL, batch and single work-item reads, work-item JSON-patch
updates (including `System.State`), and work-item comments. The CLI reaches the
fake through the existing `AZURE_DEVOPS_BASE_URL` test/proxy override, which
replaces the organization root (`https://dev.azure.com/<organization>` by
default) for the subprocess only; production behavior is unchanged when the
variable is absent.

Run just the Azure DevOps lifecycle with:

```sh
bun run --filter @devintern/e2e test
# or directly, from packages/e2e
bun test tests/local/tracker-azure-devops-fake.test.ts
```

### Worker Azure DevOps polling

`tests/local/worker-azure-devops-polling.test.ts` starts the built worker
daemon with `tracker = "azure-devops"`, a ready-state WIQL `task_query`,
`poll_interval = 1`, the deterministic agent, a local bare remote, and the same
fake (constructed with `realClock: true` so `System.ChangedDate` falls on the
real UTC day). It asserts the fake received the product's day-precision delta
`SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= '<YYYY-MM-DD>'`,
that the ready item is implemented once (branch, run record, comment, state)
while a decoy in another state is untouched, that several over-reported
same-day ticks add no run, agent invocation, or comment, that moving another
item into the ready state runs it once, and that a graceful restart on the same
queue database resumes from the persisted cursor. After the restart the
workspace switches to `--skip-comments`, so a processed item keeps matching the
query at the same `ChangedDate`. Only the `(key, updated)` dedupe then keeps it
from re-running. The prerequisite is the built CLI
(`bun run --filter @getdevintern/code build`); no credentials are needed.

```sh
# from packages/e2e
bun test tests/local/worker-azure-devops-polling.test.ts
```

### Azure DevOps fake

`tests/local/tracker-azure-devops-fake.test.ts` exercises key and WIQL selection, state transitions, comments, and decoy isolation against a loopback fake API. The test subprocess opts in with `DEVINTERN_E2E_FAKE_AZURE_DEVOPS=1`; project configuration cannot enable the endpoint override. `tests/local/worker-azure-devops-polling.test.ts` drives the worker daemon's Azure DevOps change detector against the same fake: delta WIQL shape, exactly-once pickup, over-reported same-day ticks, re-arm, cursor persistence across a restart, and the `(key, updated)` dedupe.
