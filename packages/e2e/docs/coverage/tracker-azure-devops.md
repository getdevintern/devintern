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

### Azure DevOps: `--estimate` story points field, estimation comment, re-estimation

- Surface: CLI `--estimate`; External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/tracker-azure-devops-estimation.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Live project. Known product defect, not fixed here: the shared `markdownToHtmlDescription` (`packages/text-formatter`) treats the `**Story Points:** N  |  **Confidence:** …` line as a pipe table and posts it inside `<pre>` with literal asterisks; the test accepts that or a `<strong>` rendering. The worker schedule and the `storyPointsField` override moved to their own rows below.
- Last reviewed: 2026-11-19

### Azure DevOps: worker `[[estimations]]` schedule, WIQL multi-item sweep, unchanged-item skip

- Surface: `devintern worker` surface; External dependency: task trackers
- Status: `default`
- Evidence: `tests/local/worker-azure-devops-scheduled-estimation.test.ts` (gap `e2e-tracker-azure-devops-scheduled-estimation`, `bun run --filter @devintern/e2e test`)
- Missing: Live project; `cron` schedules (only `interval`); a work item changed between sweeps (re-estimation through the worker; the CLI path is covered by the row above).
- Last reviewed: 2026-11-19

### Azure DevOps: configured `storyPointsField` override

- Surface: CLI `--estimate`; `.devintern-code/settings.json`
- Status: `default`
- Evidence: `tests/local/tracker-azure-devops-estimation.test.ts` ("writes Azure DevOps story points to the configured storyPointsField override"): with `{"azure-devops": {"projects": {"<AZURE_DEVOPS_PROJECT>": {"storyPointsField": "Custom.…"}}}}`, points land in the override and the default `Microsoft.VSTS.Scheduling.StoryPoints` is untouched.
- Missing: Live project; the worker `[[estimations]]` sweep with an override (the CLI path is covered).
- Last reviewed: 2026-11-19

## Tracker plan status

### Azure DevOps

- Default `test`: yes (offline fake)
- Opt-in suite: none
- Notes: Fake lifecycle: key/`--query`, state transition, comment, decoy isolation. Worker polling (WIQL `ChangedDate` delta, dedupe, re-arm, cursor restart) is offline. CLI `--estimate` (story points field, HTML estimation comment, in-place re-estimation, <24h skip, `--skip-comments`) is offline. Worker `[[estimations]]` sweep over a WIQL query is offline. The `storyPointsField` project override is offline.
- Last reviewed: 2026-11-19

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
updates (including `System.State` and
`Microsoft.VSTS.Scheduling.StoryPoints`), and work-item comments:

- `POST /{org}/{project}/_apis/wit/wiql`
- `GET /{org}/_apis/wit/workitems?ids=…` and `GET /{org}/_apis/wit/workitems/{id}`
- `PATCH /{org}/_apis/wit/workitems/{id}`: requires
  `Content-Type: application/json-patch+json` (415 otherwise) and an array of
  `add`/`replace` operations on `/fields/<reference name>`
- `GET`/`POST /{org}/{project}/_apis/wit/workItems/{id}/comments`
- `PATCH /{org}/{project}/_apis/wit/workItems/{id}/comments/{commentId}`:
  edits the comment in place (same id and `createdDate`, new `text` and
  `modifiedDate`, bumps `System.ChangedDate`); the body must be exactly
  `{ "text": string }`, and an unknown comment id is a recorded 404

Every comments route requires a `-preview` `api-version` (the product sends
`7.1-preview.3`), as the real service does; any other version is recorded as an
unexpected request and answered with 400. Fixture helpers `getStoryPoints`,
`getField`, `rawComments` (stored HTML plus timestamps), and `setNow` support
estimation assertions. The CLI reaches the
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

### Azure DevOps `--estimate`

`tests/local/tracker-azure-devops-estimation.test.ts` runs the built CLI with
`devintern <id> --estimate` against the fake and the deterministic agent in
`estimate` mode, with no `.devintern-code/settings.json`, so the product must
use its default `Microsoft.VSTS.Scheduling.StoryPoints` field. It proves:

- A first run writes 3 points through the work-item JSON patch, posts exactly
  one HTML estimation comment (marker heading, `<strong>` labels, no markdown
  headings), writes `estimation-result.json`, records one `estimate` run, and
  leaves the state unchanged.
- An unchanged item is skipped (no agent call, comment, or run). After a human
  comment bumps `System.ChangedDate`, a re-estimate edits the same comment in
  place through the comments `PATCH` route (same id and `createdDate`, later
  `modifiedDate`, new body with 5 points) and writes 5 points; a third run
  skips because the durable baseline absorbs the estimation's own writes.
- An item created less than 24 hours ago is skipped without any write.
- `--skip-comments` writes the field only, and a repeat run is a no-op.
- Every case: no branch, commit, or push on the local bare remote, and no
  unexpected route reached the fake.

The prerequisite is the built CLI (`bun run --filter @getdevintern/code build`);
no credentials are needed.

```sh
# from packages/e2e
bun test tests/local/tracker-azure-devops-estimation.test.ts
```

- The `storyPointsField` override test writes
  `.devintern-code/settings.json` with
  `"azure-devops".projects.<project>.storyPointsField = "Custom.E2EStoryPointsOverride"`
  and asserts the points land in that field and not in the default one.

### Worker Azure DevOps scheduled estimation

`tests/local/worker-azure-devops-scheduled-estimation.test.ts` starts the built
worker with `tracker = "azure-devops"` and one `[[estimations]]` entry
(`interval = "15m"`, WIQL `[System.Tags] CONTAINS '<marker>'`) against the fake.
It seeds two old matching work items, a decoy outside the query, and a matching
item created "now" (via `setNow`). It proves:

- The first start only registers the schedule (`interval:15m`, no run, no WIQL).
- After the cursor is moved to a missed due time, one sweep runs: a single WIQL
  request with the configured query returning all three matches, two
  `estimate`-origin runs attributed to the estimation id (no branch, repo, or
  PR), 3 points in `Microsoft.VSTS.Scheduling.StoryPoints` and one estimation
  comment on each old item, the new item skipped (`< 24h`), the decoy untouched,
  and the state unchanged.
- A second due sweep re-runs the same WIQL and skips both unchanged items: no
  new run, agent call, field write, or comment.
- No branch, commit, or push on the local bare remote, and no unexpected route
  reached the fake.

The prerequisite is the built CLI (`bun run --filter @getdevintern/code build`);
no credentials are needed.

```sh
# from packages/e2e
bun test tests/local/worker-azure-devops-scheduled-estimation.test.ts
```
