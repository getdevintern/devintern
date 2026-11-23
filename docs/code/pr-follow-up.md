---
title: "PR Follow-up: Reviews, Conflicts, CI, and Auto-merge"
sidebarLabel: "PR Follow-up"
description: "Use when the worker should keep its pull requests moving: addressing review feedback, resolving merge conflicts, fixing CI, auto-merging safe PRs, and answering @mentions."
section: "Automation"
order: 2.2
dateModified: 2026-11-18
---

# PR Follow-up: Reviews, Conflicts, CI, and Auto-merge

After the [worker](./worker.md) opens a pull request, it keeps watching it. This page covers what it does with the PRs it created, and with teammates' PRs when you opt in. Everything works by polling; the [relay](./relay.md) only makes it faster. GitHub is fully supported; GitLab support is noted per feature.

| Feature                                                     | Default | Setting                                    |
| ----------------------------------------------------------- | ------- | ------------------------------------------ |
| [Address review feedback](#review-feedback-on-the-agents-prs) | on      | always on for the agent's PRs              |
| [Resolve merge conflicts](#merge-conflicts-on-the-agents-prs) | on      | `[workspace].conflict_resolution`          |
| [Sync teammates' PRs](#syncing-teammates-open-prs)          | off     | `[[repos]].sync_team_prs`                  |
| [Auto-merge safe PRs](#auto-merging-safe-prs)               | off     | `[workspace].auto_merge`                   |
| [Fix failing CI](#ci-failures-on-the-agents-prs)            | off     | `[workspace].ci_failure_fix`               |
| [Respond to `@mentions`](#mention-the-bot-on-any-pr)        | on      | needs the relay or a customer-owned App    |

All of these settings apply without a restart. The worker never force-pushes: if someone pushed to the branch meanwhile, its push is rejected instead of overwriting their work.

## Review feedback on the agent's PRs

When someone requests changes or leaves new inline comments on a PR the worker created, the worker addresses the feedback automatically. No mention is needed. Review feedback runs before new task pickup. Merged and closed PRs drop off the watch list within one poll. If a run fails after the agent opened a PR itself, the worker still labels and watches that PR. Only repositories listed in `workspace.toml` are watched: after you rename or transfer a repository, update its `[[repos]]` entry, or its open PRs are dropped from the watch list at the next startup.

## Merge conflicts on the agent's PRs

When one of the agent's PRs falls behind its base branch, the worker merges the base into the PR branch. If that conflicts, the agent resolves the conflicted files, checking for semantic breakage as well as conflict markers. The result is pushed as a normal merge commit and a comment on the PR reports what happened. If the merge changes a lockfile, dependencies are reinstalled before hooks and the push. Stacked PRs benefit most, since merging one PR often moves the next one's base.

The worker waits until the PR head has been quiet for a short period before acting, and retries failed attempts with backoff. New commits on the PR start a fresh attempt. To resolve one PR on demand at any time:

```bash
devintern resolve-conflicts <pr-url>
```

Run from a checkout of a workspace repository, `resolve-conflicts` and `address-review` use the workspace and repo credentials and the worker's sign-in. In other checkouts they use that project's own `.devintern-code` configuration.

On GitLab, conflict resolution supports `auto` mode and the manual command. `scheduled` mode does not process GitLab MRs yet; see [GitLab integration](./gitlab-integration.md).

### Choosing when conflicts are resolved

Each resolution is an agent run. `[workspace].conflict_resolution` controls when they happen:

| Value                | Behavior                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `"auto"` (default)   | Resolve as soon as a conflict is detected.                                                     |
| `"scheduled"`        | Queue conflicts and resolve them in an off-peak window.                                        |
| `"disabled"`         | Do not watch for conflicts. PRs stay conflicted until resolved by hand or with `resolve-conflicts`. |

```toml
[workspace]
conflict_resolution = "scheduled"
conflict_resolution_cron = "0 3 * * *"   # or conflict_resolution_interval = "1d"
```

In scheduled mode, set exactly one of `conflict_resolution_cron` (worker host timezone) or `conflict_resolution_interval`. The window stays open for `WORKER_RESOLVE_WINDOW_GRACE_MINUTES` (default 60), and longer while a chain of sibling PRs is still being resolved. A window missed while the worker was down runs after restart. PRs that were merged or stopped conflicting before the window are skipped without an agent run. Review feedback is never delayed.

The tradeoff: between windows a conflicted PR cannot be merged, so keep `auto` if your team relies on instant rebases. The setting is workspace-wide.

### Choosing the agent for conflict resolution

Conflict resolution is usually mechanical, so it can run on a cheaper model:

```toml
[workspace]
conflict_resolution_model = "sonnet"     # primary harness; failover still applies
# conflict_resolution_harness = "codex"  # pin one agent (opts out of failover)
# conflict_resolution_effort = "low"
```

These keys behave like an automation's [`harness`, `model`, and `effort`](./automations.md#choosing-the-agent-per-schedule). A pinned harness that hits its usage limit defers the resolution to later polls; after three deferrals in a row, the PR waits until its head or base moves, or until you run `resolve-conflicts` by hand. A manual `resolve-conflicts` run uses the normal environment.

### When a resolution keeps failing

After `WEBHOOK_MAX_RETRIES` failed attempts, the worker stops trying on that PR. It tries again in full once the PR's head changes. If the base branch moves on in the meantime, the worker makes one more attempt. It waits at least 3 hours after the last failure, then 6, then 12, and at most a day. A temporary failure therefore clears up within hours, while a conflict the agent cannot resolve costs about one run a day instead of one per merge. To retry right away, run `devintern resolve-conflicts <pr-url>`.

### Tuning

| Variable                         | Default | Description                                                         |
| -------------------------------- | ------- | ------------------------------------------------------------------- |
| `WEBHOOK_MAX_RETRIES`            | `3`     | Attempts per conflict before the worker stops trying (see above)    |
| `WORKER_BASE_SYNC_QUIET_SECONDS` | `30`    | How long the PR head must stay unchanged before the worker acts     |
| `WORKER_RESOLVE_TIMEOUT_SECONDS` | `1800`  | Time limit per resolution run; `0` disables                         |

## Syncing teammates' open PRs

Base sync can also cover teammates' open PRs in a repository. Opt in per repo:

```toml
[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
sync_team_prs = true
```

Eligible PRs are open, not drafts, from a branch in the same repository (not a fork), and by an author GitHub lists as owner, member, collaborator, or maintainer. They get the same conflict handling as the agent's own PRs, including `conflict_resolution` mode and windows (`disabled` turns this off too). Review feedback on teammates' PRs is never addressed. Only the first 100 open PRs per repo are considered.

Because this hands teammates' code to the agent, each opted-in repo must set an explicit sandbox in its environment: `AGENT_SANDBOX=native`, `nono`, or `docker`. Unset, `none`, and `auto` are refused at startup and on reload. `sync_team_prs` is GitHub-only.

## Auto-merging safe PRs

Set `auto_merge = true` to have the worker merge its own PRs once they are green and safe, so small docs fixes do not wait in a review queue. It is off by default and GitHub-only.

```toml
[workspace]
auto_merge = true
auto_merge_safe_paths = ["**/*.md", "docs/**", "packages/*/tests/e2e/**"]
auto_merge_deny_paths = ["**/migrations/**", "**/package.json", "bun.lock"]
auto_merge_review = true                         # agent reviews PRs outside the safe paths
auto_merge_method = "squash"                     # merge | squash | rebase
auto_merge_review_label = "needs-human-review"   # label for PRs left open; "" disables
auto_merge_policy = "standard"                   # strict (default) | standard | relaxed | custom
# auto_merge_model = "sonnet"                    # also auto_merge_harness / auto_merge_effort

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
auto_merge_safe_paths = ["e2e/**"]               # replaces the workspace list for this repo
auto_merge_review_instructions = "Changes under billing/ always need a human."
```

Each PR passes these gates in order. Any "no" leaves it open for a human:

1. **Ready.** Open, not a draft, not from a fork, checks passing, no conflicts, and no outstanding "changes requested" review. Branch protection still applies. The head commit must be unchanged for 5 minutes (`WORKER_AUTO_MERGE_QUIET_SECONDS`).
2. **Deny paths.** A changed file matching `auto_merge_deny_paths` or a built-in deny path (`.github/**`, `**/CODEOWNERS`, `.devintern-code/**`) blocks the merge.
3. **Safe paths.** If every changed file matches `auto_merge_safe_paths`, the PR merges with no agent run.
4. **Agent review.** Otherwise, with `auto_merge_review = true` (the default), the agent reviews the diff and the PR merges only on an explicit "safe" verdict.

Globs are repo-relative; `docs/` means `docs/**`. A rename counts both paths. Per-repo `auto_merge_safe_paths`, `auto_merge_deny_paths`, `auto_merge_policy`, `auto_merge_rules` / `auto_merge_rules_file`, and `auto_merge_review_instructions` replace the workspace values. The merge is pinned to the commit that passed the gates. A PR left open is checked again after new commits or a policy change.

### Review policy

`auto_merge_policy` picks the rubric the agent review in gate 4 judges PRs by. Whatever the policy, the review never merges a PR it is unsure about, a diff it cannot read in full (truncated, generated, binary, or over 150,000 characters), or a PR whose text tells it to approve.

| Policy               | Leaves open for a human                                                                                                                                                                                                                                                                                                                  | Use when                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `strict` (default)   | Any runtime behavior change, security surface, irreversible effect, or weakened test or check. In practice only docs, tests, and provably behavior-preserving refactors merge.                                                                                                                                                           | You are starting out, or every behavior change should get a human look.            |
| `standard`           | Changes to auto-merge itself; CI, build, release, version bumps, and published manifest fields; weakened tests or checks; auth, credentials, redaction, webhook signatures, fail-open changes; sandbox or agent permissions; destructive data changes; default flips without opt-in; new or major-upgraded dependencies; untested behavior changes. | Tested feature and bug-fix PRs should merge, but risky categories need a human.   |
| `relaxed`            | Changes to auto-merge itself; CI, release, and publishing; weakened tests; auth, credentials, fail-open changes; sandbox or agent permissions; deleting data the PR did not create; behavior changes with no test covering them.                                                                                                         | A well-tested repo where dependency upgrades, migrations, and documented default changes may merge too. |
| `custom`             | Whatever your own rules say (`auto_merge_rules` or `auto_merge_rules_file`).                                                                                                                                                                                                                                                             | None of the presets fits your repository.                                          |

| Setting                          | Default  | What it does                                                                                                                                                                                                                       |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto_merge_policy`              | `strict` | `strict`, `standard`, `relaxed`, or `custom`.                                                                                                                                                                                      |
| `auto_merge_rules`               | none     | The rubric for `custom`, inline. Up to 20,000 characters.                                                                                                                                                                         |
| `auto_merge_rules_file`          | none     | The rubric for `custom`, in a file. Relative paths are taken from the workspace home (`~/.devintern`); `~` is expanded. The file is read on every review, so edits apply right away and re-check PRs it left open. Up to 20,000 characters. |
| `auto_merge_review_instructions` | none     | Extra rules added after the rubric for any policy, including `custom`, for example paths that always need a human. They can only make the review stricter. Set `""` in a `[[repos]]` entry to drop the workspace text for that repo. |

`custom` needs exactly one of `auto_merge_rules` and `auto_merge_rules_file`, and those keys are rejected under any other policy. A `[[repos]]` entry that sets either key replaces the workspace's rules for that repo. Rules come only from `workspace.toml` or the file it names, never from the repository being reviewed. If the rules file is missing, empty, unreadable, or too long, the review does not run: the PR stays open, and the status comment names the problem.

```toml
[workspace]
auto_merge_policy = "custom"
auto_merge_rules_file = "merge-rules.md"   # ~/.devintern/merge-rules.md
```

```markdown
Answer "safe": false for any change to billing/, payments/, or database migrations.
Tested changes elsewhere may merge. Documentation and test-only changes are safe.
```

Changing the policy, the rules, or the instructions re-checks PRs that were left open. All of these keys apply on reload, without a restart.

The worker explains each decision in one status comment on the PR, edited in place (an agent hold names the policy it ran under, such as `standard` or `custom: merge-rules.md`), and labels PRs left open with `auto_merge_review_label`. If the agent is usage-limited, the check waits for the quota to reset, and that wait does not count as a failed attempt. A check that fails (for example, the agent returns no verdict) is retried after 5 and then 10 minutes. After the third failure on the same commit, the status comment says the check kept failing, and the PR waits for new commits or a policy change. The dashboard's **Automations** page lists an **Auto-merge** entry; its **Run now** checks every open PR immediately.

The GitHub credential needs `Pull requests: Read and write` and `Contents: Read and write`. To test the gates on one PR without merging:

```bash
devintern auto-merge <pr-url> --safe-path '**/*.md' --dry-run
```

Other flags: `--deny-path` (repeatable), `--no-review`, `--method`, `--policy <strict|standard|relaxed|custom>`, `--rules=<text>`, `--rules-file <path>`, `--review-instructions=<text>`, `--review-label <name>`, `--no-review-label`.

## CI failures on the agent's PRs

Set `[workspace].ci_failure_fix = true` to have the agent repair failing CI on the PRs the worker created. It is off by default because each repair spends tokens and may push a commit.

The worker watches GitHub Actions workflow runs and commit statuses while each PR is open. Failed and timed-out runs trigger a repair; the worker waits for pending workflows first. Each failure gets up to `CI_FIX_MAX_ATTEMPTS` repair attempts (default 3), then the worker comments on the PR and waits for a human push or a green run. For GitLab code hosts, the same setting watches pipelines and required jobs on the worker's MRs; `allow_failure`, manual, skipped, and canceled jobs are ignored.

A fine-grained token (or a customer-owned App) needs **Actions: Read** and **Commit statuses: Read** in addition to the normal PR and contents permissions. If you add these permissions to an existing GitHub App installation, re-approve the installation. CI providers that only publish check runs are not watched unless they also publish a commit status. A missing or rejected credential is logged once per hour per repository, and repair resumes once access works again.

## Mention the bot on any PR

Teammates can direct the agent on any PR, not only the agent's own, with a comment such as `@devintern address the review feedback`. In the standard setup the worker recognizes `@devintern-ai` through the relay and the central App; without the relay, configure a [customer-owned App](./configuration.md#advanced-customer-owned-github-app).

- Only users with write, maintain, or admin access can direct the agent.
- Fork PRs are skipped unless they allow maintainer edits.
- Mentions posted before the worker first started are ignored.
- A mention that fails is retried up to `WORKER_FEEDBACK_MAX_ATTEMPTS` times (default 3). Mentions interrupted by shutdown or usage limits are retried without counting as an attempt.
