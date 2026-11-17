# Agent harness e2e coverage

Scope: agent harness invocation, the deterministic fake agent, and multi-harness failover (injected tasks and conflict resolution).

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Installed harness invocation argv (all registered harnesses, when installed)

- Surface: External dependency: agent harnesses and failover
- Status: `default`
- Evidence: `tests/local/harness-invocation.test.ts`
- Missing: Full agent task per harness.
- Last reviewed: 2026-11-17

### Deterministic fake agent implementation/review/CI/conflict modes

- Surface: External dependency: agent harnesses and failover
- Status: `default`
- Evidence: `tests/local/harness.test.ts`
- Missing: —
- Last reviewed: 2026-11-17

### Multi-harness failover on usage limit

- Surface: External dependency: agent harnesses and failover
- Status: `default`
- Evidence: `tests/local/worker-harness-failover.test.ts` (injected tasks) and `tests/local/worker-conflict-failover.test.ts` (worker conflict-resolution failover: quota-then-success and all-harness deferral). `bun run build`, then `bun run --filter @devintern/e2e test`.
- Missing: Real harness limit text drift, failback after the reset window.
- Last reviewed: 2026-11-17

### Harness failover

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-harness-failover.test.ts`
- Missing: Failback after the reset window and restart-time restore of the persisted chain.
- Last reviewed: 2026-11-17

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 14: ~~Harness failover with stub harnesses~~ (injected tasks in `tests/local/worker-harness-failover.test.ts`; worker conflict-resolution failover in `tests/local/worker-conflict-failover.test.ts`). Failback after the reset window is still open.

## Test notes

### Agent harness invocation checks

The ordinary local suite also probes every registered agent harness whose CLI is
installed on the machine. Harnesses that are not installed are reported as
skipped, so the suite behaves the same on a laptop with six agent CLIs and in CI
with none.

Each installed harness is launched with the exact non-interactive invocation
DevIntern generates (subcommand, flags, and prompt) inside a temporary home and
workspace. The check asserts only that the CLI accepts that invocation: a
removed flag, renamed subcommand, or changed prompt mode fails with a
parser/usage error. Sign-in prompts, missing provider keys, model errors, and
runs that exceed the probe timeout are expected and do not fail the suite, so no
AI account, credentials, or model calls are required. The probe environment
excludes ambient provider keys and harness configuration.

Set `E2E_HARNESS_PROBE_TIMEOUT_MS` to tune the per-harness timeout (default
`10000`). These checks do not run full agent tasks; the deterministic fake agent
continues to cover the implementation, git, and pull-request lifecycle.

### Worker harness failover (usage limit)

The default local suite drives the real `devintern worker` daemon through the
failover state machine with a two-entry `AGENT_HARNESS=claude-code,codex` chain
whose harness CLIs are local stubs under the fixture root
(`tests/local/worker-harness-failover.test.ts`). No agent CLI, account, model
call, or network access is used.

The primary stub (pinned with `CLAUDE_CODE_CLI_PATH`) only prints a recognized
limit pair — `Claude usage limit reached` plus the adjacent `resets in 1 hour`
hint — and exits non-zero; it never edits the repository. The fallback stub
(pinned with `CODEX_CLI_PATH`) `exec`s the deterministic `helpers/fake-agent.ts`
with the original argv, so it performs the canonical implementation edit. The
test clears the fixture's global `AGENT_CLI_PATH`: env-driven harness
resolution prefers it over every `<HARNESS>_CLI_PATH`, so leaving it set would
send the codex retry back to the primary.

The covered path asserts the row settles `done` with a `deferred` attempt
recorded for the limited primary and exactly one `succeeded` attempt for the
fallback; that the primary stub ran exactly once (no post-limit retry); that the
pushed branch contains `export const greeting = "Hello, world!";` and differs
from the base only in `src/greeting.ts`; that the fallback reached
`E2E_AGENT_INVOCATIONS`; that the worker logs name the
`claude-code → codex` failover instead of a generic failure; and that
`webhook_meta` persists a future `rate_limit:claude-code` window with
`failover:active_harness=codex`. A usage limit lands after `prepare-branch`
created the unsuffixed feature ref (nothing was pushed), so the retried attempt
records and pushes `feature/<task-key>-attempt-2`, matching the documented
fresh-attempt naming. The second scenario makes both stubs limit and asserts the
row is requeued `pending` with two `deferred` runs, no branch on the bare
remote, both persisted windows, and a worker that stays alive.

Failback after the primary's reset window elapses is not covered: the stub
windows are one hour, and the process-scoped resume timer is out of scope for
this offline suite.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

### Worker conflict-resolution failover

`tests/local/worker-conflict-failover.test.ts` covers the same two-entry
`AGENT_HARNESS=claude-code,codex` chain on a real worker conflict-resolution
job, plus the one-shot `devintern resolve-conflicts` contract. No GitHub,
GitLab, Jira, or agent account is used.

The fixture seeds a genuine merge conflict on a temporary bare remote
(`git init --bare`) and serves the open MR from a loopback GitLab API fake.
`git` reaches that remote through `url.<bare>.insteadOf`, so the worker's
clone, fetch, and push stay on the local repository. The primary stub records
its invocation, prints `Claude usage limit reached` with the adjacent
`resets in 1 hour` hint, and exits non-zero. The fallback stub `exec`s
`helpers/fake-agent.ts`, which resolves `src/greeting.ts` to
`Hello, merged!`. `AGENT_CLI_PATH` is cleared so `<HARNESS>_CLI_PATH` selects
each stub. `HOME`, `XDG_CONFIG_HOME`, the queue DB, and the output directory
come from the fixture's isolated environment.

On the quota-then-success path the worker invokes the primary stub once, fails
over to codex, and updates `feature/conflict-pr` with an ordinary `git push`
(no `--force` or `+` refspec). The pushed commit's parents are the previous
feature tip and the base tip, the base branch is unchanged, and the worker
stays running. The queue has no injected task. This GitLab conflict job does
not record a run row; the processed sync id is the success signal. When both
stubs are limited, the job is deferred, both `rate_limit:` windows are
persisted, nothing is pushed, merged, or closed, the sync id stays unprocessed,
and the poller does not retry inside its 30s backoff.

The one-shot command is the documented first-harness contract
(`packages/agent-harness/src/resolver.ts`): only the primary stub runs, the
codex stub is not invoked, and an exhausted primary exits nonzero with
`Agent usage limit reached`. This suite does not add one-shot failover.

```sh
bun run build
bun run --filter @devintern/e2e test
```
