# End-to-end tests

Private Bun workspace for workflows against real services. The suites run the built
Code CLI against GitHub.com, Bitbucket Cloud, GitLab.com and GitLab Self-Managed
using a local Markdown task
and a deterministic agent. Git operations and GitHub API calls are real; no AI account
or task tracker is needed.

## Run locally

From the monorepo root:

```sh
# Local smoke tests: Turbo builds the CLI before running them.
bunx turbo run test --filter=@devintern/e2e
gh auth login --hostname github.com # once, if not already logged in
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test:e2e
```

The local suite lists opt-in suites as skipped and planned tracker coverage as
todo, so `bun run test` (or the Turbo command above) shows what it does not
exercise. Use the explicit commands below to run those suites.

Local runs default to the private `getdevintern/devintern-e2e` repository and read
credentials from `gh auth token` in memory. Your GitHub account must have write
access to that repository. No token is written to disk. Override the repository
with `E2E_GITHUB_REPOSITORY=owner/repo` and/or provide `E2E_GITHUB_TOKEN` explicitly
to use a different account or fixture repository. CI requires both variables and
never falls back to a developer's GitHub CLI login.

Use a dedicated GitHub test repository initialized with a README/default branch.
The token needs read/write Contents, Pull requests, and Issues permissions on
that repository (or equivalent classic PAT repository access). Issues: write is
only used to create the `devintern-authored` label before the PR-label scenario;
labels are shared repository configuration and that label is intentionally left
in place after cleanup. The suite does not create repositories and never changes
the default branch or its files. Branch rules must allow creating and deleting
the suite's branches.

Each test seeds the canonical `fixtures/simple-project` into a unique
`e2e/base-e2e-<uuid>` branch, then expects the CLI to create
`feature/e2e-<uuid>`. It asserts the PR's target, title, summary, remote commit,
exact changed file, and that configured `PR_LABELS` reach the real PR. A second
scenario uses invalid PR API credentials while
retaining valid Git credentials to prove a successful push cannot conceal PR
creation failure. Currently the CLI reports that failure in its output while
exiting successfully; the test checks that behavior explicitly.

## Isolation and cleanup

Subprocesses receive an allowlisted environment and temporary home, workspace,
database and output directories. Ambient tracker credentials, Git settings,
hooks and agent configuration are excluded. Tokens are passed through the
environment and Git askpass, never embedded in remote URLs or command arguments.
Telemetry, updates and license checks are disabled for the test subprocesses.

Cleanup closes PRs and deletes the exact branches owned by each scenario,
including when an assertion fails. Closed PRs remain as GitHub history. Cleanup
failures fail the test and identify the branches. A forcibly killed runner can
leave resources behind; inspect and remove its branches/PRs manually. There is
no broad branch sweep.

## CI

The ordinary `test` command runs local harness checks only, including built-CLI
Git and worker-daemon smoke tests. The `@devintern/e2e#test` Turbo task depends
on `@getdevintern/code#build`, so `bun run test` builds the CLI before the smoke
tests instead of running them against whatever `packages/code/dist` was left
behind. Runs that bypass Turbo — a direct `bun test tests/local` or
`bun run --filter @devintern/e2e test` — must build the CLI first (the GitHub E2E
workflow does); otherwise the smoke tests skip when
`packages/code/dist/index.js` is absent. The task itself stays uncached so a
stale result is never replayed locally. Live tests require the explicit
`test:e2e` command and fail if configuration is missing; direct `bun test` skips
the live suite.
Keep live tests in a trusted, uncached CI job with dedicated secrets, initially
manual or scheduled. The included **GitHub E2E** workflow is manual
(`workflow_dispatch`): configure the repository variable `E2E_GITHUB_REPOSITORY`
and secret `E2E_GITHUB_TOKEN` before running it. Do not expose these
credentials to untrusted pull-request code. Build the CLI in that job before
running the suite so the artifact matches the checkout.

## Agent harness invocation checks

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
push branches, and create project access tokens (used for a read-only Git identity
and a separate Developer bot identity). This suite targets GitLab Self-Managed; GitLab.com does not
provide the same permanent-deletion behavior. CI requires these
explicit variables and never reads local credentials. Plain HTTP is intended
for the loopback-only container; use HTTPS for remote instances. Custom CAs,
SSH aliases and proxies are not covered by this initial suite.

Normal `bun run test` runs only local harness/configuration checks. The live
GitLab suite requires `test:e2e:gitlab`; `test:e2e` remains the GitHub suite.

Infrastructure references: [GitLab Docker installation](https://docs.gitlab.com/install/docker/installation/),
[19.3.5 patch release](https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-4-2-released/).

## Bitbucket Cloud and GitLab.com

Create a **dedicated fixture repository/project** on each hosted provider and
initialize it with a README/default branch. The suites use unique target and
feature branches populated from the canonical fixture. They preserve the
repository, its default branch, and its files; cleanup closes/declines the
scenario's PR/MR and deletes only its exact branches. Closed PRs/MRs remain as
history. Existing pipelines and hooks must permit the fixture branches. Disable
unnecessary pipelines on these dedicated repositories.

Copy `packages/e2e/.env.example` to `packages/e2e/.env.local` and fill in the
provider configuration. `.env.local` is ignored by Git; Bun loads it when the
package script runs. Keep tokens out of shell history and committed files.

| Provider        | Repository variable                             | Token variable         |
| --------------- | ----------------------------------------------- | ---------------------- |
| Bitbucket Cloud | `E2E_BITBUCKET_REPOSITORY=workspace/repo`       | `E2E_BITBUCKET_TOKEN`  |
| GitLab.com      | `E2E_GITLAB_COM_PROJECT=group/subgroup/project` | `E2E_GITLAB_COM_TOKEN` |

Bitbucket currently uses the CLI's existing **Bearer** authentication: provide a
repository/workspace access token or OAuth access token with repository read/write
and pull-request read/write permissions, including permission to delete fixture
branches. Git authentication uses `x-token-auth`. Atlassian email/API tokens
requiring Basic auth are not supported by this suite or the current PR client.
See [Bitbucket authentication](https://developer.atlassian.com/cloud/bitbucket/rest/intro/).

The GitLab.com token needs `api` scope, Git push permissions (including
`write_repository` if using a token type that requires it), and permission to
create/close MRs and delete branches on the dedicated project. The hosted suite
uses `https://gitlab.com` and never reuses the Self-Managed instance's credentials.
It does not create or delete cloud projects: GitLab.com retains deleted projects
for 30 days and does not offer the local suite's permanent-deletion behavior.
See [GitLab project deletion](https://docs.gitlab.com/api/projects/#delete-a-project).

From the monorepo root:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test:e2e:bitbucket
bun run --filter @devintern/e2e test:e2e:gitlab-com
```

Each suite covers task implementation, push, exact remote commit/diff, PR/MR
metadata and an explicit target branch, followed by invalid API credentials
after a successful push. Git credentials remain valid in that negative scenario
so the API error is tested independently. Self-Managed's nonstandard-default-
branch scenario remains in `test:e2e:gitlab`. Existing `test:e2e` still selects
GitHub only. Ordinary `test` never runs live cloud suites.

The manual **Hosted source-control E2E** Actions workflow can run either provider
or both. Set the repository variables and matching token secrets from the table
on the DevIntern GitHub repository. Each job receives only its provider's token,
and no credentials are exposed to untrusted PR workflows. Missing configuration
fails the explicit live command before it mutates a remote repository.

## Remote tracker fixtures

The Markdown suites above need no task tracker. Separate opt-in suites exercise
the same built CLI against a real remote tracker ticket through the reusable
`TrackerScenario` fixture. There are two providers, both published to GitHub:

- **GitHub Issues** uses a dedicated GitHub tracker repository that is also the
  code host (the initial pairing).
- **Local GitLab Issues** uses a dedicated project on the local Self-Managed
  instance as the issue source while GitHub remains the publication host. The
  GitLab project is created from the fixture and permanently deleted in cleanup;
  the suite does not require hosted GitLab.com.

No model or AI-agent credentials are needed: the deterministic fixture agent
verifies that unique markers seeded into the ticket description and a seeded
comment reached its actual input before it edits `src/greeting.ts`. The scenario
runs both explicit-key and `--query` scenarios. The latter passes the unique
description marker to the built CLI so its production tracker client performs
search and task selection. Fixture API polling only waits for search indexing;
it does not supply task keys or filter the CLI results. Assertions inspect all
run records and prove the decoy has no run, comment, status change, or PR.

Each scenario provisions one fresh ticket in the explicitly configured tracker,
runs the CLI with comments enabled against the ticket's real key
(`feature/<key>` and run-record lookups derive from that key, not the synthetic
Markdown key), then closes the tickets, deletes only the seeded comment, closes
the scenario's PR and deletes only its branches. It also configures three
mutually-exclusive status labels plus per-project `settings.json` statuses and
asserts the final status label is applied, the obsolete status labels are
removed, and an unrelated label survives. The implementation summary comment is
read back from the tracker API rather than trusted from CLI output. Status
labels are shared tracker configuration the scenario creates but intentionally
never deletes. Ownership is recorded the moment a resource is created; cleanup
attempts every operation even after a failure and reports the ids of anything it
could not remove. The GitHub suite never creates or deletes the containing
repository and never touches pre-existing tickets; the GitLab suite removes only
the project it created.

### GitHub Issues tracker

Configure a dedicated tracker repository in `packages/e2e/.env.local` (ignored by
Git) and run:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test:e2e:tracker
```

| Variable                    | Meaning                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `E2E_TRACKER_REPOSITORY`    | Existing `owner/repo` that will host test tickets            |
| `E2E_TRACKER_TOKEN`         | Token with issues read/write on that repository              |
| `E2E_TRACKER_STATUS_LABELS` | Optional extra comma-separated status labels for transitions |

The tracker repository is also the GitHub code host, so the token needs
repository contents and pull-request write access too. Missing
`E2E_TRACKER_REPOSITORY` or `E2E_TRACKER_TOKEN` fails the opt-in command before
any remote mutation.

### Local GitLab Issues tracker

Start the local GitLab instance (see above), then provide a GitHub code host via
`E2E_GITHUB_REPOSITORY`/`E2E_GITHUB_TOKEN` (or a local `gh auth login`) and run:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test:e2e:tracker:gitlab
```

Each run creates a private `e2e-<uuid>` project on the local instance for the
issue source and deletes it in cleanup. The GitHub token must have repository
contents and pull-request write access on the code-host repository. As with the
other local GitLab suites, `E2E_GITLAB_URL` and `E2E_GITLAB_TOKEN` override the
generated `.local/gitlab.json` credentials.

Ordinary `bun run test` runs only local harness checks and never the live tracker
suites.

### Workspace tracker smoke (read-only)

The worker's shared env can be validated without creating any tracker data:

```sh
bun run --filter @devintern/e2e test:trackers
```

The command reads `DEVINTERN_ENV_FILE`, `DEVINTERN_WORKSPACE_DIR/.env`, or
`~/.devintern/.env` (in that order), detects every configured tracker, and runs
read-only checks. Jira auth/project/status/create-metadata/search, Trello
auth/board/lists/search, and the Markdown task directory are covered today. No
ticket, card, comment, label, or status is created or changed, and credentials
are never printed. The active `TASK_TRACKER` must be configured;
`JIRA_DEFAULT_PROJECT_KEY` is optional and the first accessible project is
inspected when it is absent.

This smoke is opt-in and is not part of `test`, Turbo, or CI. See
[docs/tracker-e2e-plan.md](docs/tracker-e2e-plan.md) for the staged expansion to
full Jira/Trello lifecycles and offline fake-server coverage.

## Delivery lifecycle coverage

GitHub and local GitLab also cover an agent exiting unsuccessfully after editing,
an agent producing no changes, and an existing remote feature branch. Failure
scenarios verify the recorded run is failed, no PR/MR or remote implementation
branch appears, and the target branch is unchanged. Collision scenarios verify
the existing commit survives and the new PR/MR uses `-attempt-2`.

Local GitLab additionally covers an actual rejected push using a read-only project
token, plus a review round trip. A Developer project bot opens an MR, a separate
human identity posts feedback, and `address-review` edits and pushes to that same
MR and replies to the discussion. A second CLI invocation must add no commit,
reply, or agent invocation. GitLab updates MR metadata asynchronously; the suite
waits for the pushed SHA before asserting the new head. Both project tokens expire
the next day and are removed with their disposable project.

All four areas run through the existing GitHub/GitLab commands above; no task
tracker, model credentials, or additional local environment variables are needed.
These lifecycle scenarios currently run against GitHub and local GitLab; the
hosted GitLab.com and Bitbucket suites retain their publication smoke tests.
