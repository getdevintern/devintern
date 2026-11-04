# Tracker E2E expansion plan

Status: **Layer 1 implemented** (read-only workspace smoke). **The Jira part of
Layer 3 is implemented** (offline fake lifecycle in the default suite). The
Jira/Trello Layer 2 live suites and the Trello part of Layer 3 remain planned.

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

| Tracker             | Default `test`     | Opt-in suite                           | Notes                                                                                                                                         |
| ------------------- | ------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown            | no                 | `test:trackers` (read-only path)       | Plain files, no credentials.                                                                                                                  |
| Jira                | yes (offline fake) | `test:trackers` (read-only live smoke) | Fake lifecycle: key/`--query`, transition, comment, `--skip-comments`, estimation. Real project lifecycle and live estimation remain Layer 2. |
| Trello              | no                 | `test:trackers` (read-only smoke)      | Full lifecycle planned in Layer 2.                                                                                                            |
| GitHub Issues       | no                 | `test:e2e:tracker`                     | Existing live suite; dedicated tracker repository doubles as code host.                                                                       |
| Local GitLab Issues | no                 | `test:e2e:tracker:gitlab`              | Existing live suite; creates and deletes a dedicated project.                                                                                 |
| GitLab.com Issues   | no                 | `test:e2e:tracker:gitlab-com`          | Existing live suite; pre-created project, issues only, project retained.                                                                      |
| Linear              | no                 | none                                   | Detection only in Layer 1.                                                                                                                    |
| Asana               | no                 | none                                   | Detection only in Layer 1.                                                                                                                    |
| Azure DevOps        | no                 | none                                   | Detection only in Layer 1.                                                                                                                    |

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
estimation is already covered offline in Layer 3; real Jira project lifecycle
and live estimation with a dedicated fixture project remain Layer 2.

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
variables (exact names open for review):

| Variable                      | Meaning                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `E2E_JIRA_PROJECT_KEY`        | Dedicated Jira project that hosts test issues.          |
| `E2E_JIRA_ISSUE_TYPE`         | Issue type for test issues (default `Task`).            |
| `E2E_JIRA_TODO_STATUS`        | Initial workflow status (default `To Do`).              |
| `E2E_JIRA_IN_PROGRESS_STATUS` | In-progress status (default `In Progress`).             |
| `E2E_JIRA_REVIEW_STATUS`      | Status applied after PR creation (default `In Review`). |
| `E2E_TRELLO_BOARD_ID`         | Dedicated board that hosts test cards.                  |
| `E2E_TRELLO_TODO_LIST`        | Initial list (default `To Do`).                         |
| `E2E_TRELLO_IN_PROGRESS_LIST` | In-progress list (default `Doing`).                     |
| `E2E_TRELLO_REVIEW_LIST`      | List applied after PR creation (default `Review`).      |

Credentials may come from the workspace env (`JIRA_*`, `TRELLO_*`) only when
the dedicated fixture variables are also present. Missing fixture variables
fail before the first remote mutation.

### Jira specifics

- Create issues through the REST API with a unique marker in the description
  and a decoy outside the selector, mirroring the existing scenario.
- Apply labels for the unrelated seed label; statuses are workflow transitions,
  not labels.
- Verify the configured statuses exist before creating anything.
- Cleanup: delete seeded comments, then delete scenario-owned issues (the
  account needs `DELETE_ISSUES`; it is available on the reference account) or
  transition them to Done when deletion is intentionally disabled.
- Avoid the production `DEV` project by default. A dedicated `E2E` project is
  preferred; using `DEV` with hard deletion is a fallback only.

### Trello specifics

- Use a dedicated board, or at minimum dedicated lists, so list moves and labels
  do not touch the worker board.
- Lists are statuses: create the card in the todo list, move it to the review
  list after PR creation, and assert the card's list.
- Comments are card actions; delete only the scenario's comment actions.
- Cleanup deletes or archives only scenario-owned cards. Board-scoped labels are
  created idempotently and are either left in place or deleted only when the
  fixture created them.

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

## Layer 3 — fake tracker servers for the default local suite (Jira implemented)

Run the built CLI against in-process Bun servers that implement the subset of
the tracker APIs the product uses. This gives deterministic, credential-free
lifecycle coverage in the default `test` run and catches request-shape
regressions without depending on provider availability.

### Jira (implemented)

`providers/fake-jira.ts` serves a strict Jira Cloud REST v3 subset on
`127.0.0.1:0` and owns all issues, comments, labels, statuses, and custom fields
in memory. `tests/local/tracker-jira-fake.test.ts` seeds an expected issue plus
a decoy outside the selector, writes per-project Jira statuses into
`.devintern-code/settings.json`, and runs the production Jira client through the
built CLI for both explicit-key and `--query` selection. It reads state back
through the fixture rather than CLI stdout.

`tests/local/tracker-jira-estimation.test.ts` adds the `--estimate` workflow.
Settings name `storyPointsField: "customfield_10016"` explicitly, so the test
covers the write/comment path without conflating it with field discovery. The
fake persists custom fields on `PUT /rest/api/3/issue/{key}` and exposes them
for assertions; it also implements `PUT /rest/api/3/issue/{key}/comment/{id}`
for in-place re-estimation and a deterministic clock control for the <24h skip.
Scenarios assert the story-point value, the single estimation comment (created
then updated by id, with the rewritten body carrying the new points),
`estimation-result.json`, and the skip behavior for unchanged and recent
issues. `--skip-comments` proves the field-only path and that a repeated sweep
stays a no-op without a comment to anchor the re-estimation gate. No branch,
commit, or push is created.

Endpoints covered:

- `GET /rest/api/3/myself`
- `GET /rest/api/3/search/jql` (enhanced JQL, requested issue fields)
- `GET /rest/api/3/issue/{key}` (including `?expand=renderedFields`)
- `GET /rest/api/3/issue/{key}/comment` (including `?expand=renderedBody`)
- `POST /rest/api/3/issue/{key}/comment` (ADF or text)
- `PUT /rest/api/3/issue/{key}/comment/{id}` (ADF or text)
- `GET` / `POST /rest/api/3/issue/{key}/transitions`
- `PUT /rest/api/3/issue/{key}` (labels, description, and custom fields)

Any other route returns a diagnostic 404 naming the method and path, and the
test asserts no unexpected request occurred. The fake accepts any Basic-auth
credentials, never logs them, and makes no outbound requests. Lifecycle
scenarios assert the pushed `feature/<key>` branch and exact
`src/greeting.ts` diff, the run record, the configured workflow status,
surviving unrelated labels, the implementation comment, and `--skip-comments`
on a second run. The local bare Git remote is the code host; no PR, GitHub
token, or model credentials are required. The only skip is the existing
built-CLI guard.

### Trello (planned)

The Trello fake remains planned: member/board/list reads, card create/get/update,
list moves, comments, labels, and search. Point the CLI at it through
`TRELLO_API_BASE_URL` (already supported by `TrelloClient`) with synthetic
credentials.

### Acceptance criteria (applies to each implemented fake)

- The fakes assert the exact endpoints and payloads the CLI sends.
- The CLI-visible outcomes match the real lifecycle assertions: branch/PR,
  status/list transition, comment body, and decoy untouched.
- No network access and no credentials are required.
- Fake behavior stays independent of the product clients.

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
- Which additional trackers (Linear, Asana, Azure DevOps) justify Layer 2/3
  coverage versus read-only checks only.

## Suggested order

1. Layer 1 read-only smoke (done).
2. Trello Layer 2 on a dedicated board; it needs no project provisioning.
3. Jira Layer 2 with a dedicated `E2E` project.
4. Layer 3 fake servers so the default suite covers Jira (done) and Trello
   (planned) lifecycle.
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
