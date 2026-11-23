# GitHub code host e2e coverage

Scope: GitHub.com as the code host: push, PR, lifecycle, and worker parity (review polling, CI repair, conflicts, mentions). Shared delivery notes: [code-hosts.md](code-hosts.md).

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### GitHub.com: implement, push, PR, base/title/body/diff/labels

- Surface: External dependency: source control
- Status: `live`
- Evidence: `tests/code/github.test.ts`
- Missing: Draft PRs, branch protection, merge queue, SSH remotes, Enterprise.
- Last reviewed: 2026-11-17

### GitHub agent failure/no-change and existing-branch collision

- Surface: External dependency: source control
- Status: `live`
- Evidence: `tests/code/github-lifecycle.test.ts`
- Missing: —
- Last reviewed: 2026-11-17

### GitHub: review feedback polling and reply/dedup

- Surface: External dependency: source control
- Status: `gap`
- Evidence: —
- Missing: Worker parity with the GitLab review scenario.
- Last reviewed: 2026-11-17

### GitHub: CI failure repair and retry budget

- Surface: External dependency: source control
- Status: `blocked`
- Evidence: `tests/code/github-worker.test.ts` (`bun run --filter @devintern/e2e test:e2e:github`); not yet run green.
- Missing: Prerequisite: a token with Contents, Pull requests and Commit statuses write on the fixture repository (`E2E_GITHUB_REPOSITORY`, default `getdevintern/devintern-e2e`). On 2026-11-20 both the local `gh auth token` identity and the worker's `GITHUB_TOKEN` got HTTP 404 for that repository, so the preflight stopped the suite before it created anything. Until a green run, these live behaviors are unverified: askpass-based push of the CI fix, the `--pr-target-branch` override, and polling of combined commit statuses. Keep this `blocked` until the scenarios pass against GitHub. Actions workflow-run failures (`/actions/runs?head_sha=`) and log excerpts are not exercised; the scenarios use classic commit statuses only. Observed (unconfirmed intent): without `--pr-target-branch`, a worker task targets the remote HEAD branch instead of `[[repos]].default_branch`, so the fixture pins the PR target in `worker_task_args`.
- Last reviewed: 2026-11-20

### GitHub: automatic merge-conflict resolution and scheduled mode

- Surface: External dependency: source control
- Status: `gap`
- Evidence: —
- Missing: Worker parity with the GitLab conflict scenario.
- Last reviewed: 2026-11-17

### GitHub: `@mention` handling

- Surface: External dependency: source control
- Status: `gap`
- Evidence: —
- Missing: —
- Last reviewed: 2026-11-17

### GitHub: `--auto-review` loop and iteration cap

- Surface: External dependency: source control
- Status: `default`
- Evidence: `tests/local/cli-auto-review.test.ts`
- Missing: Provider parity: real PR review feedback on GitHub/GitLab remains live/opt-in.
- Last reviewed: 2026-11-17

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 5: GitHub worker parity: review polling, CI repair, conflict resolution, mention.

## Test notes

### `tests/code/github-worker.test.ts` (live, opt-in)

Runs the built CLI as a `devintern worker` daemon against unique refs in the GitHub fixture repository, using `GITHUB_TOKEN` token mode (no App credentials, no relay) and the deterministic fake agent. A single token is enough: the worker opens the PR and posts the escalation comment, and the test posts the failing commit statuses.

- **Repair and dedupe:** a failing commit status on the PR head triggers one CI-fix agent run, which pushes a new head commit. The handled status is recorded, and later poll ticks do not run a second fix.
- **Budget exhaustion:** with `CI_FIX_MAX_ATTEMPTS=2`, the first failure gets a pushed fix and the second fix attempt on the new head fails. The worker then posts one "could not fix" comment from the token identity. A further failure on that head runs no more fixes and posts no second comment.

Run: `bun run --filter @getdevintern/code build`, then `bun run --filter @devintern/e2e test:e2e:github`. Prerequisites: `E2E_GITHUB_TOKEN` or a working `gh auth login`, with write access to `E2E_GITHUB_REPOSITORY` for contents, pull requests and commit statuses. A preflight explains what to set when the repository is unreadable or not writable. Direct `bun test` skips the file.

Cleanup closes this run's PRs and deletes the unique `e2e/base-<uuid>` and `feature/local-e2e-<id>-…` branches, even when an assertion fails. Commit statuses cannot be deleted. They remain on the run's unique head SHAs, and failure messages list them.
