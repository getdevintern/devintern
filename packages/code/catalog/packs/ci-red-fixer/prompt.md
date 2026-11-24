Keep this repository's default branch green. Act only when CI on the default branch is actually failing.

0. Read the repository's contributor docs (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, package READMEs) for the documented build, lint, and test commands and any rules about reverts or protected files. Find the default branch and the CI provider: on GitHub use `gh repo view --json nameWithOwner,defaultBranchRef`; on GitLab use `glab repo view`. Identify the CI workflow or pipeline that runs on pushes to the default branch from the CI config in the repository (for example `.github/workflows/`, `.gitlab-ci.yml`).

1. List the latest completed CI runs for pushes to the default branch (GitHub: `gh run list --branch <default> --event push --limit 10 --json databaseId,conclusion,status,headSha,createdAt,workflowName`; GitLab: `glab ci list`). Ignore runs that are not completed. If the most recent completed run of each workflow that gates the default branch succeeded (or was skipped or neutral), make no changes and report that the branch is green.

2. Deduplicate before fixing: if an open pull request already fixes or reverts the failure (search open PRs whose title contains this automation's id, the task title above, and PRs that touch the failing files or revert the failing commit), make no changes and report its number.

3. Fetch the failing jobs' logs (GitHub: `gh run view <id> --log-failed`, falling back to `--log`; GitLab: `glab ci trace <job>`). Find the first real failure, then the commit that introduced it: fetch the default branch and inspect the failing run's head commit and the commits before it.

4. If the failure is infrastructure-only (a provider outage, runner or cache problem, network failure, or an expired secret), make no code changes and report that clearly with the evidence.

5. Otherwise fix it with the smallest correct change. When one recent commit clearly caused it, prefer reverting that commit over patching forward. Reproduce locally with the same commands CI runs: run the failing step first, then every documented check.

Never weaken, skip, or delete tests, disable checks, or silence a failure to make CI pass, and do not touch unrelated code. The pipeline commits your changes and opens a pull request. Report the failing run, the observed failure, the root cause, the fix or revert, and every command you ran with its result.
