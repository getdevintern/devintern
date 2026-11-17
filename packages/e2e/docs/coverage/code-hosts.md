# Code host e2e coverage (shared)

Scope: behavior shared by every code host, plus hosts that need dedicated infrastructure. Per-host coverage: [GitHub](code-host-github.md), [GitLab](code-host-gitlab.md), [Bitbucket](code-host-bitbucket.md). Run instructions for the live suites stay in the [README](../../README.md).

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### GitHub Enterprise / custom CA / proxy / SSH aliases

- Surface: External dependency: source control
- Status: `blocked`
- Evidence: README documents the omission
- Missing: Needs dedicated infrastructure; do not fake it.
- Last reviewed: 2026-11-17

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 19: GitHub Enterprise, custom CAs, proxies, and SSH aliases only when dedicated infrastructure exists.

## Test notes

### Delivery lifecycle coverage

GitHub and local GitLab also cover an agent exiting unsuccessfully after editing,
an agent producing no changes, and an existing remote feature branch. Failure
scenarios verify the recorded run is failed, no PR/MR or remote implementation
branch appears, and the target branch is unchanged. Collision scenarios verify
the existing commit survives and the new PR/MR uses `-attempt-2`.

All four areas run through the existing GitHub/GitLab commands in the [README](../../README.md); no task
tracker, model credentials, or additional local environment variables are needed.
These lifecycle scenarios currently run against GitHub and local GitLab; the
hosted GitLab.com and Bitbucket suites retain their publication smoke tests.
