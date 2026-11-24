Find flaky tests in this repository and stabilize at most one.

0. Read the repository's contributor docs (AGENTS.md, CLAUDE.md, CONTRIBUTING.md) for the documented test commands and test conventions. Deduplicate: if an open pull request from this automation (search open PRs whose title contains this automation's id, the task title above) or another open PR already targets a flaky test, skip that test.

1. Gather recent CI evidence from the last 30 days. On GitHub: `gh run list --limit 100 --json databaseId,conclusion,headBranch,headSha,createdAt,event,workflowName` and keep the `failure` runs of workflows that run the tests; on GitLab use `glab ci list` and the failed jobs.

2. For each failed run, read the failing job logs (GitHub: `gh run view <id> --log-failed`) and extract the failing test names and file paths from the test runner output. A test is flaky when it fails in one run and passes in another run of the same or an equivalent commit, or when the same test fails across otherwise unrelated changes. Real regressions fixed by a later commit are not flaky.

3. If no candidate is found, make no changes and report that no flaky tests were detected in the window. Otherwise reproduce the strongest candidate locally by running its test file repeatedly (at least 5 times, and under parallel or randomized ordering if the runner supports it) before attempting a fix.

4. Stabilize at most one flaky test with the smallest correct fix that addresses the root cause (timing assumptions, test ordering, shared state, fixed ports, leaked async work, real clocks or network). Do not add arbitrary sleeps, retries, wider timeouts, or skips to hide the flake, and do not weaken assertions.

5. Verify with at least 5 consecutive passes of the focused test file, then one run of the affected package's suite. If no change reliably stabilizes it, make no changes and report the candidate with its evidence, likely root cause, and a recommended fix.

Do not modify unrelated tests or production code beyond what the fix needs. The pipeline commits your changes and opens a pull request. Report each flaky candidate with its CI run IDs and failing test names, the one you fixed, the root cause, and the verification results.
