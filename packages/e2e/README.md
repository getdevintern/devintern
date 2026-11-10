# End-to-end tests

Private Bun workspace for workflows against real services. The suites run the built
Code CLI, both one-shot and as the workspace worker daemon, against GitHub.com,
Bitbucket Cloud, GitLab.com and GitLab Self-Managed using a local Markdown task
and a deterministic agent. Git operations and provider API calls are real; no AI
account or task tracker is needed.

The maintained coverage inventory and gap backlog live in
[docs/coverage-matrix.md](docs/coverage-matrix.md). The recurring `e2e-expander`
workspace automation scouts that list and delegates each accepted gap to the
worker as a separate task and pull request.

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

## Local auto-review loop

`tests/local/cli-auto-review.test.ts` runs the built CLI's `--auto-review` loop
against a local bare Git remote and the deterministic fixture agent, with no
hosted PR, account, or network access. The fixture agent gains two prompt-driven
modes: `auto-review-feedback` (the bundled `review.md` prompt) prints only a
JSON verdict, and `auto-review-fix` (the bundled `fix.md` prompt) edits
`src/greeting.ts` without committing or pushing. The reviewer reports one
`medium` finding on iteration 1 and approves from iteration 2, so the loop
converges; `E2E_AUTO_REVIEW_STUCK=1` keeps every iteration unapproved to prove
`--auto-review-iterations` caps the review/fix cycles. Both modes are recorded
in `E2E_AGENT_INVOCATIONS` so the test asserts the exact
implement → review → fix → review sequence.

The scenarios assert the pushed `feature/<task-key>` branch, the exact
`src/greeting.ts` diff, the two commits ahead of base (the implementation plus
`fix: address PR review feedback`), and the
`DEVINTERN_OUTPUT_DIR/<task-key>/auto-review-summary.json` artifact
(`iterations`, `success`, and `history`). Per-iteration verdicts are saved under
`iteration-<n>/feedback.json`. A non-approved loop still exits 0 and delivers
the branch; the local remote has no supported PR host, so `--create-pr` pushes
and exits without a PR URL.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

## Worker `worker add` option matrix

The default local suite (`tests/local/worker-add-options.test.ts`) drives the built
CLI's `devintern worker add` through every documented option against a throwaway
workspace and a local bare Git remote seeded from `fixtures/simple-project`; no
tracker or hosted code host is involved. Enqueue-only cases cover `--title`,
`--body`, `--body-file <path>`, `--body-file -` stdin, `--idempotency-key`,
`--workspace`, `--json`, and the validation errors. Daemon cases cover `--wait`,
`--wait-timeout` (`0` and a bounded timeout through `E2E_AGENT_DELAY_MS`), and
`--resume`, asserting the pushed branch/commit directly on the bare remote rather
than a pull request.

## Worker workspace bootstrap (`worker scaffold` and `worker add-repo`)

The default local suite (`tests/local/worker-workspace-bootstrap.test.ts`) drives
the built CLI's non-interactive onboarding path in a temporary HOME and
workspace. It seeds a local bare Git remote and a checkout (no network, tracker,
or credentials), then asserts the on-disk result rather than CLI prose:

- `worker scaffold` writes `workspace.toml` and the shared `.env` with mode
  `0600`; a second run exits non-zero without changing either file.
- The generated TOML parses through a follow-up `worker add` invocation.
- `worker add-repo` derives a filesystem-safe `[[repos]]` name from the remote,
  does not pin a transient `origin/HEAD`, and seeds a `[[routing.rules]]` entry
  from `JIRA_DEFAULT_PROJECT_KEY` (or `LINEAR_DEFAULT_TEAM_KEY`).
- Missing repo env keys merge into the shared `.env`; conflicting values are
  demoted to the repo's inline `[repos.env]` instead of overwriting shared
  values.
- Re-running `add-repo` is idempotent, and running from a package subdirectory
  still resolves the repository-root `.devintern-code/.env`.
- A missing workspace or a checkout without an `origin` exits non-zero and
  writes nothing.

The temporary root (HOME, workspace, bare remote, and seed checkout) is removed
in `finally`; the run creates no resource outside it.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

## Scheduled workspace automations

`tests/local/worker-automations.test.ts` starts one real `devintern worker`
against a throwaway workspace whose `[[automations]]` entries are all scheduled
on the next cron minute (`cron = "* * * * *"`). It seeds a local bare Git remote
from `fixtures/simple-project`, uses the deterministic fake agent, and reads the
queue database and the bare remote instead of parsing CLI stdout. The matrix
covers:

- `open_pr = true`: the run is `scheduled`, records a branch, and the branch on
  the bare remote changes exactly `src/greeting.ts` in one commit. PR creation
  itself is not covered here: the bare remote has no detectable code-host
  platform, so the run succeeds with `pr_url` null and the code-host suites own
  that path. A second workspace in the same file omits `--create-pr` from its
  defaults, proving the automation's own `open_pr` opt-in still pushes a branch.
- `open_pr = false`: the agent still runs (each invocation is attributed to its
  automation via `DEVINTERN_AUTOMATION_ID`), but the per-automation policy
  (`--no-git`) suppresses the branch and push even though the workspace
  `worker_task_args` include `--create-pr`.
- `allow_no_changes = true` with an `E2E_NO_CHANGE` prompt: the unchanged run
  succeeds and publishes no branch or commit (a local branch may still be
  recorded).
- `allow_no_changes` unset with the same prompt: the run fails with the
  documented missing-commit reason and publishes nothing.
- Occurrence markdown files exist under `<workspace>/automations/<id>/`,
  `automation_schedules` has one row per enabled automation, and no unconfigured
  automation produces a run.
- After the first window settles, a fifth automation is appended to
  `workspace.toml`; the live reloader reconciles it and its next occurrence
  records a `scheduled` run.

The file costs up to two cron boundaries for the main workspace (the first
window and the reloaded automation share a minute) plus one more for the opt-in
fixture, so allow roughly three minutes. Run it with the rest of the default
local suite:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

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

## Worker harness failover (usage limit)

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

## Worker conflict-resolution failover

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

## Sandbox checks (nono, native, docker, removed providers)

The ordinary local suite exercises sandbox provider selection and the
fail-closed guarantee deterministically, plus the real nono boundary when nono
is installed. A deterministic shell agent reports what it could write and read,
so no AI account is needed.

The fail-closed and doctor checks always run against the built CLI. A provider
that is explicitly requested but cannot be enforced must abort before the
agent edits or pushes anything — never silently fall back to an unsandboxed
run:

| Provider | Default-offline check                                               | Optional real boundary                              |
| -------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| `nono`   | Removed from `PATH`; exits non-zero, no probe, no commit.           | Runs when installed, with `HOME` outside `/tmp`.    |
| `docker` | `sbx ls` shadowed to fail (unreachable daemon); exits non-zero.     | Not runnable with the shell probe (see below).      |
| `native` | Unsupported harness (`goose`) with a stub `goose`; exits non-zero.  | Needs a real claude-code/codex account, so not run. |
| `auto`   | Picks `native` for a native-capable harness and `nono` for `goose`. | —                                                   |
| invalid  | `--sandbox bogus` and `AGENT_SANDBOX=bogus` both exit non-zero.     | —                                                   |
| removed  | `--sandbox srt` / `smolvm` and `AGENT_SANDBOX` forms exit non-zero. | —                                                   |

The same suite covers the `devintern sandbox` doctor for non-nono providers:
native as the next run for claude-code/codex, docker refusing to claim a
sandboxed run when `sbx` cannot list its daemon, a missing harness CLI surfacing
as a preflight failure with the `*_CLI_PATH` fix, and the removed `srt`/`smolvm`
providers reporting a migration error instead of an unknown-provider list.

Docker Sandboxes (`sbx`) stays optional. Its real-boundary test skips unless the
prerequisite below is present; the fail-closed test still runs by shadowing the
executable. `sbx` only runs agents pre-installed in its guest microVM and
ignores the host executable path, so the deterministic shell probe cannot
exercise its boundary; its coverage here is selection, doctor reporting, and
fail-closed behavior.

### Optional real-provider prerequisites

- **Docker Sandboxes**: the `sbx` CLI signed in (`sbx login`) with a reachable
  daemon; `sbx ls` must succeed.

Removed providers (`srt`, `smolvm`) have no prerequisite and no boundary test:
the suite only asserts that selecting either one fails with a migration message
naming `nono` or `docker`.

The sandbox suite keeps the nono isolated `HOME` outside the OS temp directory:
nono's Linux profile grants a broad read on `/tmp`, and a home nested under
that grant makes nono refuse its own per-user deny rules. Real user homes are
normally outside `/tmp`, so the fixture mirrors that. Other providers use a
workspace-local isolated home.

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

## Offline fake tracker servers

The default local suite includes in-process fake Jira Cloud v3 and Trello REST
servers, so the built CLI can exercise both tracker lifecycles with no
credentials and no network access. `bun run --filter @devintern/e2e test` (or
`bun test tests/local` after building) runs
`tests/local/tracker-jira-fake.test.ts` and
`tests/local/tracker-trello-fake.test.ts`; they skip only when the built CLI is
absent, like the other local Git tests.

### Jira fake

The fake binds `127.0.0.1:0`, accepts any Basic-auth credentials (and never logs
them), and implements only the endpoints the product calls: `/myself`, enhanced
JQL `search/jql`, issue read/update, comments (ADF and text), and workflow
transitions. Any unmatched request returns a diagnostic 404 and fails the test,
so a client change that starts calling a new route is visible instead of
silently returning `{}`.

Two scenarios run the production Jira client through explicit-key and `--query`
selection against a seeded issue and a decoy outside the selector. Read-back
goes through the fake fixture, not CLI stdout: the pushed `feature/<key>` branch
and exact `src/greeting.ts` diff, the run record, the configured workflow
status, surviving unrelated labels, the implementation summary comment, and
delivery of the seeded description/comment markers to the deterministic agent.
A second run with `--skip-comments` proves no additional comment or transition
is posted. The local bare Git remote is the code host; no GitHub token or PR is
required.

### Offline fake Linear server

The same default suite also includes an in-process Linear GraphQL fake
(`providers/fake-linear.ts`), so the built CLI exercises the Linear tracker
lifecycle without a Linear workspace, token, or network access.
`tests/local/tracker-linear-fake.test.ts` skips only when the built CLI is
absent.

The fake binds `127.0.0.1:0` on a single `POST /graphql` endpoint, accepts any
`Authorization` header without logging it, and serves one in-memory team with
Todo/In Progress/In Review workflow states, issues, labels, and markdown
comments. It implements only the operations the product calls: `IssueById`,
`IssueComments`, `TeamStates`, `CommentCreate`, `IssueUpdate`, and
`SearchIssues`. Any other operation or malformed payload returns a diagnostic
GraphQL error and fails the test through `unexpectedOperations`.

The fixture supplies `TASK_TRACKER=linear`, a synthetic `LINEAR_API_KEY`, and
`LINEAR_API_URL=http://127.0.0.1:<port>/graphql`; no environment variable is
inherited. Two scenarios run the production Linear client through explicit-key
and JSON IssueFilter `--query` selection against a seeded issue and a decoy
outside the selector. Read-back goes through the fake fixture, not CLI stdout:
the pushed `feature/<key>` branch and exact `src/greeting.ts` diff, the run
record, the configured workflow state, surviving unrelated labels, the
implementation summary comment, delivery of the seeded description/comment
markers to the deterministic agent, and an untouched decoy. The local bare Git
remote is the code host; no PR, GitHub token, or model credentials are required.

## Remote tracker fixtures

The Markdown suites above need no task tracker. Separate opt-in suites exercise
the same built CLI against a real remote tracker ticket through the reusable
`TrackerScenario` fixture. There are three providers, all published to GitHub:

- **GitHub Issues** uses a dedicated GitHub tracker repository that is also the
  code host (the initial pairing).
- **Local GitLab Issues** uses a dedicated project on the local Self-Managed
  instance as the issue source while GitHub remains the publication host. The
  GitLab project is created from the fixture and permanently deleted in cleanup;
  the suite does not require hosted GitLab.com.
- **GitLab.com Issues** uses a pre-created project on GitLab.com as the issue
  source while GitHub remains the publication host. The project is never
  deleted; scenario issues are closed in cleanup.

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
could not remove. The GitHub and GitLab.com suites never create or delete the
containing repository/project and never touch pre-existing tickets; the local
GitLab suite removes only the project it created.

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

### GitLab.com Issues tracker

Configure a dedicated GitLab.com project with Issues enabled in
`packages/e2e/.env.local` (the hosted source-control project works when Issues is
enabled), provide a GitHub code host, and run:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test:e2e:tracker:gitlab-com
```

| Variable                 | Meaning                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `E2E_GITLAB_COM_PROJECT` | Existing GitLab.com project path that will host test issues         |
| `E2E_GITLAB_COM_TOKEN`   | Token with `api` scope and issues/labels write access               |
| `E2E_GITHUB_REPOSITORY`  | GitHub code host; defaults to the local `gh` login's E2E repo       |
| `E2E_GITHUB_TOKEN`       | Optional explicit GitHub token; otherwise uses the local `gh` login |

The suite creates issues, labels, seeded comments and a decoy in the configured
project, then opens a GitHub PR and verifies status transitions. Cleanup closes
the scenario issues and deletes only the seeded comments and branches; the
GitLab.com project, its labels and the closed issues remain (GitLab.com does not
permanently delete projects on demand). Missing project/token configuration fails
the opt-in command before any remote mutation.

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
full Jira/Trello lifecycles and the implemented Jira/Linear fake-server coverage
(Trello fake planned).

## Standalone dashboard API

`tests/local/dashboard-api.test.ts` starts the built CLI as `devintern dashboard`
against a real `WorkerFixture` workspace, after the worker has drained one
injected task. The fixture picks a free port on the requested loopback host,
builds the health URL from that same host (bracketing IPv6 literals, so
`--host ::1` polls `http://[::1]:<port>`), and stops the process with SIGTERM in
`finally`; it never waits on a fixed timer and never binds a non-loopback
interface. The worker fixture's temporary HOME, workspace, output and queue
database are the only inputs, so no account, license, tracker, or network is
involved.

The suite asserts the read surface over that real run: health; the `/api/runs`
list with id, status, origin, task key and timestamps plus a bounded `limit`
(and the 400 for an invalid one); run detail with stages, retry eligibility,
harness-log and artifact arrays; the harness-log and artifact list routes; task
activity; empty agent-PR and automation catalogs; worker status; the worker log
tail including the daemon's captured startup banner; the documented 404 for an
unknown run id; stats with at least one succeeded run; and the 405
`{ error: "method not allowed" }` response for a non-GET `/api/runs`.
It also proves the daemon lock is observed as `running`, then stops the worker
and asserts the standalone dashboard reports `stopped` or `unknown` instead of a
phantom live worker. The write-route refusal paths are covered without side
effects: retrying the succeeded run returns 409 "not retriable: this run already
succeeded" before any spawn, a non-integer retry id returns 400, and an unknown
automation id returns 404. A separate case starts the CLI with `--host 0.0.0.0`,
asserts a non-zero exit with the loopback error, no "Dashboard running" line,
and that the chosen port is still free afterwards; another starts the fixture
with `--host ::1` (skipped only when the host cannot bind IPv6 loopback) and
asserts the bracketed health URL answers.

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

Only the successful write paths are intentionally out of scope: a retry that
actually queues work and a "Run now" that starts an automation would spawn
detached CLI work or mutate the fixture. Worker-embedded dashboard mode and log
redaction readback are likewise out of scope for this suite.

## Direct webhook serve

`tests/local/webhook-serve.test.ts` starts the built CLI as
`devintern webhook serve` on an ephemeral `127.0.0.1` port with a temporary
queue database, then sends real HTTP requests. It runs in the default offline
suite:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

The suite starts with no provider secret and asserts the documented
`WEBHOOK_SECRET, GITLAB_WEBHOOK_SECRET, or GITLAB_WEBHOOK_SIGNING_TOKEN is
required` preflight failure before the process listens. The running fixture
polls `GET /health` (it never waits on a fixed timer), checks queue and failover
state, and verifies `GET /` documents the GitHub, GitLab and health endpoints.

Signature coverage is local-only: GitHub HMAC-SHA256 over the exact raw body
(including whitespace and a one-byte tamper), GitLab's `X-Gitlab-Token`, and
GitLab Standard Webhooks (`webhook-id`, `webhook-timestamp` and the canonical
`id.timestamp.rawBody` signature). Each mode asserts the accepted and rejected
status codes, and the GitHub/GitLab duplicate-delivery paths assert that a
replay is acknowledged as a duplicate (or rejected as in progress) without
creating a second queue row. The startup preflight and the "only GitHub secret
configured" GitLab 503 case use short-lived extra server processes.

No real GitHub/GitLab host, token, webhook, relay, or hook installation is used.
Secrets are random per run, the server is bound to loopback only, and
`WEBHOOK_VALIDATE_IP` stays unset. The fixture seeds a future harness rate-limit
window before startup so an accepted review delivery remains in flight and the
dedupe branch is deterministic; this also keeps the asynchronous review pipeline
away from any provider API. Because the CLI resolves its agent harness at startup
even for `webhook serve`, the fixture pins `AGENT_CLI_PATH` to an inert stub in
its temporary root, so the server starts on machines without an agent CLI (as on
CI runners) and a delivery can never reach a real agent. The fixture also creates
the queue database inside its temporary root before spawning the server, which is
the precondition that makes `WebhookQueue` skip its one-time copy of the hardcoded legacy
`/tmp/devintern-webhooks/queue.db`; the suite asserts that precondition from
`WebhookServerFixture.preSpawnQueueDb` rather than moving the product-global
path. The temporary root (HOME, workspace, output and queue database) is removed
in `finally`, even when an assertion fails.

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

Local GitLab also runs the worker daemon itself (`tests/code/gitlab-worker.test.ts`),
not the one-shot CLI. Each scenario provisions a separate private project and a
Developer project token, then starts the built `devintern worker` against a real
workspace. Coverage includes an injected task producing a labelled MR, GitLab
Issues polling with status transition and actioned deduplication, registered-MR
review polling, CI repair through an external failed commit status, retry-budget
escalation, and automatic conflict resolution after the base branch advances.
Relay delivery, `worker connect gitlab` hook installation, and real project-hook
callbacks remain out of scope for the ordinary worker suite: they need relay
infrastructure or a GitLab container-to-worker callback path.

The separate opt-in `test:e2e:gitlab-relay` suite uses the **deployed** relay.
It installs a real managed project hook, proves review feedback arrives with
normal polling effectively disabled, verifies MR-close unwatching, and checks
that `--disconnect` removes the managed hook and stops deliveries. It needs a
signed-in Supabase session (`E2E_RELAY_AUTH_SESSION`, or the local
`~/.devintern/state/code/.auth-session.json`), an entitled account, and the
local GitLab container. It writes a temporary hook and relay route, then removes
both in cleanup. Run it with:

```sh
bun run --filter @devintern/e2e test:e2e:gitlab-relay
```

CI must provide `E2E_RELAY_AUTH_SESSION` explicitly; the suite is not part of
PR CI.

### Worker working windows

`tests/local/worker-working-windows.test.ts` verifies that a ready task waits outside the configured UTC windows and that `worker run-now` drains it once.
