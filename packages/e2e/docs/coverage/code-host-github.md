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
- Status: `gap`
- Evidence: —
- Missing: Worker parity with the GitLab CI scenarios.
- Last reviewed: 2026-11-17

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
