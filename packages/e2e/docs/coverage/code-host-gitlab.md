# GitLab code host e2e coverage

Scope: GitLab Self-Managed and GitLab.com as the code host, including the live GitLab worker suite. Shared delivery notes: [code-hosts.md](code-hosts.md).

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### GitLab Self-Managed: MR, default branch, invalid API credentials

- Surface: External dependency: source control
- Status: `live`
- Evidence: `tests/code/gitlab.test.ts`
- Missing: —
- Last reviewed: 2026-11-17

### GitLab Self-Managed: collision, rejected push, address-review

- Surface: External dependency: source control
- Status: `live`
- Evidence: `tests/code/gitlab-lifecycle.test.ts`
- Missing: Standalone `address-review` CLI options.
- Last reviewed: 2026-11-17

### GitLab Self-Managed worker: injected task, polling, CI repair/escalation, review, conflict

- Surface: External dependency: source control
- Status: `live`
- Evidence: `tests/code/gitlab-worker.test.ts`
- Missing: Automations, estimations, quiet hours, failover, orphan recovery, service, auto-update.
- Last reviewed: 2026-11-17

### GitLab.com: implement, push, MR, invalid API credentials

- Surface: External dependency: source control
- Status: `live`
- Evidence: `tests/code/gitlab-com.test.ts`
- Missing: Worker/lifecycle/review/CI/conflict coverage.
- Last reviewed: 2026-11-17

## Test notes

### Local GitLab lifecycle

Local GitLab additionally covers an actual rejected push using a read-only project
token, plus a review round trip. A Developer project bot opens an MR, a separate
human identity posts feedback, and `address-review` edits and pushes to that same
MR and replies to the discussion. A second CLI invocation must add no commit,
reply, or agent invocation. GitLab updates MR metadata asynchronously; the suite
waits for the pushed SHA before asserting the new head. Both project tokens expire
the next day and are removed with their disposable project.

### Local GitLab worker

Local GitLab also runs the worker daemon itself (`tests/code/gitlab-worker.test.ts`),
not the one-shot CLI. Each scenario provisions a separate private project and a
Developer project token, then starts the built `devintern worker` against a real
workspace. Coverage includes an injected task producing a labelled MR, GitLab
Issues polling with status transition and actioned deduplication, registered-MR
review polling, CI repair through an external failed commit status, retry-budget
escalation, and automatic conflict resolution after the base branch advances.
Hosted relay delivery, `worker connect gitlab` hook installation, and real
project-hook callbacks remain out of scope for the ordinary worker suite: they
need relay infrastructure or a GitLab container-to-worker callback path. The
relay's tracker `task.changed` contract is covered offline against a loopback
fake; see [Relay `task.changed` delivery (offline)](relay.md#relay-taskchanged-delivery-offline).
