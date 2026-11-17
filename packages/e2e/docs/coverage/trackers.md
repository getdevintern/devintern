# Tracker e2e plan and shared rules

Scope: cross-tracker plan and rules: goals, the Layer 1 read-only smoke, the Layer 2 provider contract, the Layer 3 fake-server approach, and cross-cutting rules. Per-tracker coverage lives in [tracker-markdown.md](tracker-markdown.md), [tracker-github-issues.md](tracker-github-issues.md), [tracker-gitlab-issues.md](tracker-gitlab-issues.md), [tracker-jira.md](tracker-jira.md), [tracker-trello.md](tracker-trello.md), [tracker-linear.md](tracker-linear.md), [tracker-asana.md](tracker-asana.md), and [tracker-azure-devops.md](tracker-azure-devops.md). This file absorbs the former `tracker-e2e-plan.md`.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

Status: **Layer 1 implemented** (read-only workspace smoke). **The Jira and
Linear parts of Layer 3 are implemented** (offline fake lifecycles in the
default suite). The Jira/Trello Layer 2 live suites and the Trello part of Layer
3 remain planned.

This plan describes how `packages/e2e` grows tracker coverage without making the
default `bun run test` depend on the network or credentials, and without writing
test data into the trackers a worker actually uses.

## Goals

- Cover the task trackers used by a real worker workspace: Jira, Trello,
  Markdown, GitHub Issues, GitLab Issues, and eventually Linear, Asana, and
  Azure DevOps.
- Keep the ordinary local suite (`tests/local`, `bun run test`) offline,
  credential-free, and fast.
- Never mutate a production Jira project or Trello board. Write suites must use
  explicitly configured, dedicated fixtures.
- Keep provider API logic independent from the product clients so a test can
  catch a client regression instead of mirroring it.
- Record which suites ran and which were skipped, and why.

## Current coverage

The per-tracker status that used to be a table here is the "Tracker plan status" section of each tracker file.

The default local run reports these opt-in suites as skipped and planned
coverage as todo (`helpers/opt-in-suites.ts`), so the test output names what it
does not exercise.

## Layer 1 — read-only workspace smoke (implemented)

### Command

```sh
bun run --filter @devintern/e2e test:trackers
```

The command reads the worker's shared env file, detects every tracker whose
required variables are present, and runs read-only checks. It is not part of
`test`, Turbo, or CI.

### Env resolution

1. `DEVINTERN_ENV_FILE` (explicit path; `~` is expanded)
2. `DEVINTERN_WORKSPACE_DIR/.env`
3. `~/.devintern/.env`

The file is parsed line-wise (`KEY=value`), never sourced through a shell.
Values such as `TRELLO_DEFAULT_LIST_NAME=To Do` contain spaces and would be
corrupted by shell evaluation. Non-empty process environment values override
the file so a caller can override one setting.

### Checks

| Tracker  | Read-only checks                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jira     | Auth (`/myself`), project access (configured key or first accessible project), workflow statuses, create metadata, `BROWSE_PROJECTS`/`CREATE_ISSUES` permissions, JQL search. |
| Trello   | Auth (`/members/me`), board resolution (configured board or first open board), lists, configured default list, search.                                                        |
| Markdown | `MARKDOWN_TASKS_DIR` exists, is a directory, and counts `.md` files.                                                                                                          |

No tickets, cards, comments, labels, or status transitions are created,
changed, or deleted.

### Safety

- Tokens are never printed. Trello authenticates through query parameters, so
  error messages redact credential values and their URL-encoded forms.
- Jira's `JIRA_DEFAULT_PROJECT_KEY` is optional for the smoke: `@getdevintern/code`
  can work from issue keys and team queries without it. When absent, the first
  accessible project is inspected read-only.
- Trello requires an explicit `TRELLO_API_KEY` for the smoke even though the
  product can fall back to a bundled key, so the check never depends on a value
  compiled into the product.
- A configured tracker without an implemented check is reported as skipped, and
  the run fails if no configured tracker has a read-only check.

### Files

- `helpers/workspace-env.ts` — env path resolution and line-wise parsing.
- `helpers/tracker-smoke.ts` — tracker registry and read-only checks.
- `tests/trackers/workspace-trackers.test.ts` — per-tracker tests.
- `scripts/trackers.ts` — CLI runner and configuration summary.

### Limitations

- Does not exercise task selection, status transitions, comments, PR creation,
  or cleanup.
- Does not prove a ticket can be created; only that create metadata and
  permissions are visible.
- Depends on live network access to the configured trackers. It is therefore
  opt-in and should not gate CI.

## Layer 2 — full lifecycle against dedicated fixtures (planned)

Reuse the existing `TrackerScenario` and `assertTrackerLifecycle` machinery,
with Jira and Trello fixtures and provider-specific status semantics. CLI
One-shot and scheduled worker estimation are already covered offline in Layer 3;
real Jira project lifecycle and live estimation with a dedicated fixture project
remain Layer 2.

### Provider contract changes

The current lifecycle assumes label-based statuses and an `is:open <marker>`
selector. Generalize `TrackerFixture`:

- `statusKind: "labels" | "state"` and `getStatus(ticketKey)`.
  - GitHub/GitLab keep label-based assertions.
  - Jira returns the workflow status name.
  - Trello returns the list name.
- `selectorQuery(marker)` returns the provider-native query used by `--query`.
  - GitHub/GitLab: existing query.
  - Jira: `project = "<KEY>" AND text ~ "<marker>"`.
  - Trello: `is:open <marker>` scoped to the fixture board.
- `assertTicketState` branches on `statusKind`: label assertions for
  label-based providers; status/list equality for state-based providers.
- `closeTicket` keeps provider semantics:
  - Jira: transition to Done, or delete the scenario-owned issue when the
    fixture opts into hard deletion.
  - Trello: archive or delete the scenario-owned card.

### Fixture configuration

Write suites must never fall back to the worker's production settings. Required
variables live in each tracker file (Jira, Trello).

Credentials may come from the workspace env (`JIRA_*`, `TRELLO_*`) only when
the dedicated fixture variables are also present. Missing fixture variables
fail before the first remote mutation.

### Commands and acceptance

```sh
bun run --filter @devintern/e2e test:e2e:tracker:jira
bun run --filter @devintern/e2e test:e2e:tracker:trello
```

Acceptance criteria:

- Key and `--query` scenarios both pass for each provider.
- The PR targets the unique base ref and contains only `src/greeting.ts`.
- The final status/list is applied, the unrelated label survives, and the
  implementation summary is read back from the tracker.
- The decoy has no run, comment, status change, or PR.
- Cleanup removes every scenario-owned ticket/card/comment even after a
  failure; labels and the containing project/board remain.
- Missing fixture configuration fails before any remote mutation.
- A rerun does not collide with leftovers from a previous run.

## Layer 3 — fake tracker servers for the default local suite (Jira, Linear, Trello, Asana, and Azure DevOps implemented)

Run the built CLI against in-process Bun servers that implement the subset of
the tracker APIs the product uses. This gives deterministic, credential-free
lifecycle coverage in the default `test` run and catches request-shape
regressions without depending on provider availability.

### Shared fake-server notes

The default local suite includes in-process fake Jira Cloud v3 and Trello REST
servers, so the built CLI can exercise both tracker lifecycles with no
credentials and no network access. `bun run --filter @devintern/e2e test` (or
`bun test tests/local` after building) runs
`tests/local/tracker-jira-fake.test.ts` and
`tests/local/tracker-trello-fake.test.ts`; they skip only when the built CLI is
absent, like the other local Git tests.

Two scenarios per fake run the production client through explicit-key and
`--query` selection against seeded items and a decoy outside the selector.
Read-back goes through the fixture, not CLI stdout: the pushed `feature/<key>`
branch and exact `src/greeting.ts` diff, the run record, the configured
workflow status/state, surviving unrelated labels/tags, the implementation
summary comment, and delivery of the seeded description/comment markers to the
deterministic agent. The local bare Git remote is the code host; no GitHub
token, tracker token, or PR is required.

### Acceptance criteria (applies to each implemented fake)

- The fakes assert the exact endpoints and payloads the CLI sends.
- The CLI-visible outcomes match the real lifecycle assertions: branch/PR,
  status/list transition, comment body, and decoy untouched.
- No network access and no credentials are required.
- Fake behavior stays independent of the product clients.

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 17: ~~Linear fake lifecycle~~ (implemented by `tests/local/tracker-linear-fake.test.ts`); Linear read-only checks plus Asana and Azure DevOps read-only checks, then fake lifecycles.

## Cross-cutting rules

- **No production fallback for writes.** A write suite must require its
  dedicated `E2E_*` fixture variables. Never derive a write target from
  `TASK_TRACKER`, `JIRA_DEFAULT_PROJECT_KEY`, or `TRELLO_DEFAULT_BOARD_ID`.
- **Read-only and write runs are separate commands.** The default `test` stays
  offline; read-only smoke and write suites are opt-in.
- **No secrets in output.** Redact tokens and URL-encoded tokens; never print
  request URLs that contain Trello credentials.
- **Parse env files as data.** Do not `source` the worker `.env`; values may
  contain spaces and `#`.
- **Provider-native semantics stay in the fixture.** Statuses, query syntax,
  comment models, and cleanup differ per tracker; the shared lifecycle should
  not hardcode one provider's shape.
- **Ownership-based cleanup.** Record resource ids when created, attempt every
  cleanup operation, and report anything that could not be removed. Never
  delete a containing project, board, or shared label set without explicit
  ownership.

## Open questions

- Dedicated Jira `E2E` project versus using `DEV` with hard-deleted issues.
- Dedicated Trello board versus dedicated lists on the existing board.
- Whether the read-only smoke should run as part of the release automation or
  stay a manual pre-flight.
- Which additional trackers (Linear, Asana) justify Layer 2/3 coverage versus
  read-only checks only.

## Suggested order

1. Layer 1 read-only smoke (done).
2. Trello Layer 2 on a dedicated board; it needs no project provisioning.
3. Jira Layer 2 with a dedicated `E2E` project.
4. Layer 3 fake servers so the default suite covers Jira, Linear, and Trello
   lifecycle (done).
5. Add read-only checks for Linear, Asana, and Azure DevOps when credentials
   exist.
6. Revisit live GitHub/GitLab tracker smoke only if the full suites start
   drifting from the worker configuration.

## References

- `packages/e2e/README.md` — run commands and existing live suites.
- `packages/e2e/helpers/tracker-scenario.ts` — shared remote-tracker lifecycle.
- `packages/e2e/helpers/tracker-lifecycle.ts` — provider-agnostic assertions.
- `packages/e2e/providers/tracker.ts` — fixture contract.
- `packages/code/src/lib/trackers/capabilities.ts` — tracker capabilities and
  required env.
- `packages/task-trackers/src/config/tracker-meta.ts` — canonical tracker
  metadata.
