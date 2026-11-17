# E2E coverage matrix

Living inventory of what `packages/e2e` actually exercises, what it only
partially exercises, and what is still missing. The inventory is split into one
file per area under [`coverage/`](coverage/), so parallel e2e pull requests for
different areas never edit the same lines. The `e2e-expander` workspace
automation scouts the area files and delegates the highest-value gaps to the
worker as separate ad-hoc tasks. Each delegated task updates its own area file
in its own PR.

This index holds only the legend, the rules, and the list of areas. It should
rarely change.

## Status legend

| Status    | Meaning                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| `default` | Runs in `bun run test` (offline, credential-free).                                                          |
| `live`    | Opt-in package script against a real service; requires credentials or local infrastructure.                 |
| `partial` | Some layers are covered, but the listed behavior or edge case is not.                                       |
| `gap`     | No end-to-end coverage; a unit test may exist.                                                              |
| `blocked` | Cannot be automated safely yet; record the exact prerequisite instead of adding a permanently skipped test. |

A row is `default` or `live` only when a test file is named. Tests are the source
of truth; the area files are a snapshot.

## How to record coverage

- A new or changed test updates **only its area file** under
  `packages/e2e/docs/coverage/`: its row (a `###` entry under `## Coverage`),
  the row's `Last reviewed` date, any `## Backlog` item it completes, and the
  test's description under `## Test notes`.
- Do not edit this index, `packages/e2e/README.md`, or another area's file for
  an ordinary new test. The README holds only general run instructions and
  setup for live suites.
- A new area is the only reason to change the index: add the area file and one
  line to [Areas](#areas).
- Each row is its own block separated by blank lines, not a table row, so the
  formatter never re-pads neighbouring rows and two PRs that touch different
  rows do not conflict. Add new rows at the end of `## Coverage`.

Row format:

```md
### <behavior, command, or flag>

- Surface: <External dependency: …> | `devintern` command surface | `devintern worker` surface
- Status: `default` | `live` | `partial` | `gap` | `blocked`
- Evidence: <test file(s) and the command that runs them, or —>
- Missing: <what is still not covered, or —>
- Last reviewed: <YYYY-MM-DD>
```

## Areas

External dependencies (trackers, code hosts, sandboxes, harnesses, relay, and
hosted services) are the highest priority because provider APIs, CLIs, and
binaries drift independently of this repository.

Trackers:

- [coverage/trackers.md](coverage/trackers.md): cross-tracker plan (Layers 1–3), shared fixture rules, and cross-cutting rules.
- [coverage/tracker-markdown.md](coverage/tracker-markdown.md): local Markdown task files and mixed batches.
- [coverage/tracker-github-issues.md](coverage/tracker-github-issues.md): GitHub Issues as the tracker.
- [coverage/tracker-gitlab-issues.md](coverage/tracker-gitlab-issues.md): local GitLab and GitLab.com Issues.
- [coverage/tracker-jira.md](coverage/tracker-jira.md): Jira fake lifecycle, estimation, smoke, and Layer 2 plan.
- [coverage/tracker-trello.md](coverage/tracker-trello.md): Trello fake lifecycle, board-actions worker polling, smoke, and Layer 2 plan.
- [coverage/tracker-linear.md](coverage/tracker-linear.md): Linear GraphQL fake lifecycle.
- [coverage/tracker-asana.md](coverage/tracker-asana.md): Asana fake lifecycle and Events API worker polling.
- [coverage/tracker-azure-devops.md](coverage/tracker-azure-devops.md): Azure DevOps fake lifecycle and WIQL worker polling.

Code hosts:

- [coverage/code-hosts.md](coverage/code-hosts.md): shared delivery lifecycle notes and infrastructure-blocked hosts.
- [coverage/code-host-github.md](coverage/code-host-github.md): GitHub.com push, PR, lifecycle, and worker parity.
- [coverage/code-host-gitlab.md](coverage/code-host-gitlab.md): GitLab Self-Managed and GitLab.com, including the live worker suite.
- [coverage/code-host-bitbucket.md](coverage/code-host-bitbucket.md): Bitbucket Cloud.

Runtime and services:

- [coverage/sandbox.md](coverage/sandbox.md): sandbox providers, workspace grants, `--sandbox`, and `devintern sandbox`.
- [coverage/harnesses.md](coverage/harnesses.md): harness invocation, the fake agent, and multi-harness failover.
- [coverage/relay.md](coverage/relay.md): relay delivery, `task.changed`, and `worker connect` relay targets.
- [coverage/services.md](coverage/services.md): auth, licensing, Sentry monitors, telemetry, and update checks.
- [coverage/dashboard.md](coverage/dashboard.md): standalone and worker-embedded dashboard.
- [coverage/webhook.md](coverage/webhook.md): `devintern webhook serve`.

Commands:

- [coverage/cli.md](coverage/cli.md): the one-shot `devintern` task run, its flags, and standalone commands.
- [coverage/worker-daemon.md](coverage/worker-daemon.md): the worker daemon loop, schedules, routing, and concurrency.
- [coverage/worker-commands.md](coverage/worker-commands.md): `worker init`, `login`, `scaffold`, `add-repo`, `add`, `connect`, and `run-now`.

## How to refresh the inventory

- Task-run surface: `packages/code/src/lib/cli/program.ts` (flags) and
  `packages/code/src/index.ts` (top-level dispatch).
- Worker surface: `packages/code/src/lib/worker/cli.ts` (subcommands and daemon)
  and the implementations under `packages/code/src/lib/worker/` and
  `packages/code/src/lib/workspace/`.
- Direct webhook surface: `packages/code/src/lib/code-host/cli.ts`,
  `packages/code/src/webhook-server.ts`, and `packages/code/src/lib/webhook/`.
- Intended behavior: `docs/code/*.md`.
- Existing suites: `packages/e2e/tests/{local,code,trackers}` and
  `packages/e2e/helpers/opt-in-suites.ts`.
- Run `bun run --filter @devintern/e2e test` for the default inventory; the
  suite lists every opt-in and planned suite as skipped or todo.

## Delegation

The scout ranks every accepted gap by value and dispatches them with
`devintern worker add` in descending order, using stable
`e2e-<area>-<slug>` idempotency keys. There is no fixed per-run cap: it rejects
blocked or low-value candidates instead of padding the batch. It does not edit
the area files itself; the delegated task updates the row in its PR. A gap with
an open PR, a merged test, or a queued/running task is not delegated again.

## Priority backlog

Backlog items live in the `## Backlog` section of their area file, each labelled
`Priority <n>`. The numbers are one global ranking (1 is highest). Work top to
bottom across all area files; the scout delegates every accepted gap
highest-value first, and each task opens its own PR. A task that completes an
item strikes it through in its area file; it does not renumber other items.

## Rules for adding a row

- Name the exact test file and the command that runs it.
- Do not mark `default` for a test that skips without credentials or remote
  infrastructure. Optional local binaries (nono, harness CLIs) are allowed only
  when the skip is explicit and the test still proves the fallback path.
- Do not mark `live` without running it on this machine at least once; otherwise
  keep it `gap`/`blocked` and state the prerequisite.
- Record cleanup ownership in the `Evidence` field when the suite creates remote
  resources.
- Never write to a production tracker or repository. Use a disposable local
  project, a dedicated fixture, or a fake server.
