# End-to-end tests

Private Bun workspace for workflows against real services. The first suite runs
the built Code CLI against GitHub.com using a local Markdown task and a
deterministic agent. Git operations and GitHub API calls are real; no AI account
or task tracker is needed.

## Run locally

From the monorepo root:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
E2E_GITHUB_REPOSITORY=your-org/devintern-e2e \
E2E_GITHUB_TOKEN=your-token \
bun run --filter @devintern/e2e test:e2e
```

Use a dedicated GitHub test repository initialized with a README/default branch.
The token needs read/write Contents and Pull requests permissions on that
repository (or equivalent classic PAT repository access). The suite does not
create repositories and never changes the default branch or its files. Branch
rules must allow creating and deleting the suite's branches.

Each test seeds the canonical `fixtures/simple-project` into a unique
`e2e/base-e2e-<uuid>` branch, then expects the CLI to create
`feature/e2e-<uuid>`. It asserts the PR's target, title, summary, remote commit
and exact changed file. A second scenario uses invalid PR API credentials while
retaining valid Git credentials to prove a successful push cannot conceal PR
creation failure. Currently the CLI reports that failure in its output while
exiting successfully; the test checks that behavior explicitly.

## Isolation and cleanup

Subprocesses receive an allowlisted environment and temporary home, workspace,
database and output directories. Ambient tracker credentials, Git settings,
hooks and agent configuration are excluded. Tokens are passed through the
environment and Git askpass, never embedded in remote URLs or command arguments.
Telemetry, updates and license checks are disabled for the test subprocesses.

Cleanup closes PRs and deletes the exact two branches owned by each scenario,
including when an assertion fails. Closed PRs remain as GitHub history. Cleanup
failures fail the test and identify the branches. A forcibly killed runner can
leave resources behind; inspect and remove its branches/PRs manually. There is
no broad branch sweep.

## CI

The ordinary `test` command runs local harness checks only, including a built-CLI
Git smoke test when `packages/code/dist/index.js` exists. Live tests require
the explicit `test:e2e` command and fail if configuration is missing; direct
`bun test` skips the live suite. Keep live tests in a trusted, uncached CI job
with dedicated secrets, initially manual or scheduled. The included **GitHub E2E**
workflow is manual (`workflow_dispatch`): configure the repository variable
`E2E_GITHUB_REPOSITORY` and secret `E2E_GITHUB_TOKEN` before running it. Do not expose these
credentials to untrusted pull-request code. Build the CLI in that job before
running the suite so the artifact matches the checkout.
