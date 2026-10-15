# End-to-end tests

Private Bun workspace for workflows against real services. The suites run the built
Code CLI against GitHub.com and GitLab Self-Managed using a local Markdown task
and a deterministic agent. Git operations and GitHub API calls are real; no AI account
or task tracker is needed.

## Run locally

From the monorepo root:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
gh auth login --hostname github.com # once, if not already logged in
bun run --filter @devintern/e2e test:e2e
```

Local runs default to the private `getdevintern/devintern-e2e` repository and read
credentials from `gh auth token` in memory. Your GitHub account must have write
access to that repository. No token is written to disk. Override the repository
with `E2E_GITHUB_REPOSITORY=owner/repo` and/or provide `E2E_GITHUB_TOKEN` explicitly
to use a different account or fixture repository. CI requires both variables and
never falls back to a developer's GitHub CLI login.

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

## Local GitLab Self-Managed

Docker Engine and Docker Compose must be installed and accessible to your user.
The setup pins GitLab CE 19.3.5 and binds HTTP to **127.0.0.1:8929** only. It
uses named Docker volumes for GitLab configuration, logs and repository data;
first startup downloads the image and can take several minutes. Budget roughly
8 GB of available RAM and 15 GB of disk space for this development service.

```sh
# From the monorepo root:
bun run --filter @devintern/e2e gitlab:up
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test:e2e:gitlab
bun run --filter @devintern/e2e gitlab:status
bun run --filter @devintern/e2e gitlab:down
```

`gitlab:up` waits for readiness, then creates a 30-day API token for the local
container's root account. This token is for this isolated development instance
only. It is saved in ignored `packages/e2e/.local/gitlab.json` with mode 0600 and
never printed. Subsequent starts reuse valid credentials; rerun `gitlab:up` to
replace expired credentials. `gitlab:down` stops the service and preserves data;
it does not delete Docker volumes. There is no automatic system startup.

Each scenario creates a private project from the canonical fixture, then permanently
deletes that project in cleanup and waits for it to disappear. This bypasses
the Self-Managed instance's delayed-deletion retention for generated fixtures. Tests
cover MR creation against an explicit branch, a nonstandard default branch when
no target is supplied, and rejected MR API credentials after a successful push.
They verify the remote commit and exact diff. CI pipelines in fixture projects
are disabled. The CLI's experimental GitLab code-host flag is set only inside
test subprocesses. No task-tracker or real AI-agent credentials are needed.

To use another test instance, set **both** `E2E_GITLAB_URL` and
`E2E_GITLAB_TOKEN`. The token needs `api` scope and permission to create/delete
private projects in its own namespace, permanently remove those projects, and
push branches. This suite targets GitLab Self-Managed; GitLab.com does not
provide the same permanent-deletion behavior. CI requires these
explicit variables and never reads local credentials. Plain HTTP is intended
for the loopback-only container; use HTTPS for remote instances. Custom CAs,
SSH aliases and proxies are not covered by this initial suite.

Normal `bun run test` runs only local harness/configuration checks. The live
GitLab suite requires `test:e2e:gitlab`; `test:e2e` remains the GitHub suite.

Infrastructure references: [GitLab Docker installation](https://docs.gitlab.com/install/docker/installation/),
[19.3.5 patch release](https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-4-2-released/).
