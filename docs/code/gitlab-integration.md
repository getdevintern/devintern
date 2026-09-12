---
title: "GitLab integration for @devintern/code"
sidebarLabel: "GitLab Integration"
description: "Implement GitLab issues and experimentally create merge requests on GitLab.com or GitLab Self-Managed."
section: "Code"
order: 6
sidebarHidden: true
dateModified: 2026-09-10
tags: ["gitlab", "gitlab-self-hosted", "devintern/code", "integration"]
---

# GitLab integration for @devintern/code

@devintern/code can implement work directly from GitLab issues: fetch issue details and comments, run a feasibility check, move status labels, execute your AI agent, commit changes, and post results back on the issue. Both **GitLab Cloud** and **self-hosted instances** are supported.

GitLab can also be used independently as the code host. Experimental code-host support creates merge requests on GitLab.com or one configured GitLab Self-Managed instance. Your task may come from any supported tracker; the origin Git remote determines where the pull or merge request is created.

## Prerequisites

- [Bun](https://bun.sh) and `@getdevintern/code` installed globally
- GitLab personal access token with the `api` scope
- Git repository for your project

## Setup

### 1. Set the task tracker

In `.devintern-code/.env`:

```bash
TASK_TRACKER=gitlab
```

### 2. Add GitLab credentials

```bash
# Cloud default — omit for gitlab.com; set for self-hosted:
GITLAB_BASE_URL=https://gitlab.example.com

GITLAB_TOKEN=glpat_xxxxxxxxxxxx
GITLAB_PROJECT=group/sub/repo
```

- `GITLAB_BASE_URL` — instance root URL. Omit for GitLab Cloud (`https://gitlab.com` is the default). Self-hosted instances keep their protocol, so internal `http://` hosts work.
- `GITLAB_TOKEN` — personal access token from `/-/user_settings/personal_access_tokens` on the same instance, with the **`api`** scope.
- `GITLAB_PROJECT` — project path (`group/repo`, subgroups allowed: `group/sub/repo`) or a numeric project ID.

### 3. Configure status labels

Like GitHub Issues, GitLab has no built-in workflow states that map cleanly across teams, so @devintern/code maps statuses to labels. Create the labels in your project, then configure them in `.devintern-code/settings.json` using the project path as the key:

```json
{
  "gitlab": {
    "projects": {
      "acme/team/webapp": {
        "inProgressStatus": "In Progress",
        "todoStatus": "To Do",
        "prStatus": "In Review"
      }
    }
  }
}
```

To keep statuses mutually exclusive, also list them in `.devintern-code/.env`:

```bash
GITLAB_STATUS_LABELS=To Do,In Progress,In Review
```

When a status changes, @devintern/code adds the target label and removes the other labels in this list. Transitioning to `closed` or `done` closes the issue instead of applying a label; moving back to an open status reopens it.

## Running an issue

Pass an issue number, `#number`, a `group/sub/repo#123` reference, or a full issue URL:

```bash
# Issue number
devintern 123 --create-pr

# Full issue URL (self-hosted URLs work too)
devintern https://gitlab.com/acme/team/webapp/-/issues/123 --create-pr
```

This workflow:

1. Fetches the issue body, labels, and comments
2. Runs a feasibility assessment (skippable with `--skip-clarity-check`)
3. Applies the `inProgressStatus` label (unless `--skip-comments` is set)
4. Creates a feature branch, runs your agent, commits, and optionally opens a pull or merge request
5. Applies the `prStatus` label after PR creation
6. Posts implementation or assessment comments on the issue

## Experimental merge-request creation

GitLab code-host support is shipping as an experimental stack: MR creation, manual review addressing, registered-MR polling, base synchronization, CI repair, hosted relay delivery, and repo-local direct webhooks are available. Broad `@mention` discovery and scheduled GitLab conflict windows are not enabled.

Add a separate code-host profile to `.devintern-code/.env`:

```bash
DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST=true

# Omit for GitLab.com. For Self-Managed, use the instance root, including any
# relative installation path.
GITLAB_CODE_HOST_URL=https://gitlab.example.com

# Personal, project, or group access token with API access.
GITLAB_CODE_HOST_TOKEN=glpat_xxxxxxxxxxxx

# Optional: use a separate Maintainer/Owner token only for relay hook setup.
GITLAB_WEBHOOK_ADMIN_TOKEN=glpat_xxxxxxxxxxxx
```

Then run the existing compatible command:

```bash
devintern PROJ-123 --create-pr
devintern PROJ-123 --create-pr --pr-target-branch develop
```

`--create-pr` remains the stable cross-provider flag. On a detected GitLab remote it opens a merge request and reports GitLab-native terminology in the result.

The GitLab task tracker and code-host credentials are deliberately independent. `GITLAB_TOKEN` is reused only when `TASK_TRACKER=gitlab` and `GITLAB_BASE_URL` exactly matches the code-host instance. A token is never forwarded to a different host.

### Self-Managed remotes

HTTPS, normal SSH URLs, SCP-style SSH URLs, subgroups, custom ports, and relative installation paths are supported. If SSH config uses a hostname alias that differs from the browser URL, list it explicitly:

```bash
GITLAB_CODE_HOST_URL=https://gitlab.corp.example/platform
GITLAB_CODE_HOST_ALIASES=corp-git,gitlab-vpn
```

DevIntern recognizes `gitlab.com`, the configured instance host, and these explicit aliases. It does not probe or guess unknown hosts.

For an internal certificate authority, provide a readable PEM bundle. Do not disable TLS verification:

```bash
GITLAB_CODE_HOST_CA_FILE=/etc/company/gitlab-ca.pem
```

Bun honors standard `HTTP_PROXY` and `HTTPS_PROXY` variables. An integration-specific proxy can override them:

```bash
GITLAB_CODE_HOST_PROXY=http://proxy.corp.example:8080
```

### Creation behavior

- An explicit `--pr-target-branch` is authoritative; otherwise DevIntern uses the repository default branch.
- Source and target branches are checked through the GitLab API before creation.
- Duplicate recovery requires the same instance, source project and branch, and target project and branch.
- `PR_LABELS` remains supported. Only labels already present in the GitLab project are applied; missing labels produce a warning and are not created.
- MR creation failure retains the existing nonfatal PR behavior: the pushed branch remains available and the task run reports the failure.
- Created MRs are stored with provider, instance, numeric project ID, project path, IID, and canonical URL. The dashboard displays the stored URL.

### Current capability matrix

| Capability | GitLab status |
| --- | --- |
| GitLab.com MR creation | Experimental |
| Latest stable GitLab Self-Managed MR creation | Experimental |
| Personal, project, and group access tokens | Supported for API access |
| Existing labels | Best-effort; missing labels are skipped |
| Manual `address-review` | Experimental; same-project writable branches only |
| Registered-MR polling | Experimental; DevIntern-created MRs only |
| Conflict/base synchronization | Experimental; `auto` mode and manual command |
| CI repair | Experimental; registered MRs through polling, relay, or direct webhooks |
| Hosted relay | Experimental; automatic project hooks, no worker inbound port |
| Direct project webhooks | Experimental; repo-local server only |
| Repository-wide mentions | Deferred |

The validated Self-Managed target is the latest stable GitLab release at the time @devintern/code ships. Other REST API v4 versions continue best-effort with a compatibility warning.

## Address GitLab review feedback manually

With the same experimental flag and code-host credentials used for MR creation, run:

```bash
devintern address-review https://gitlab.com/group/project/-/merge_requests/123
```

Self-managed MR URLs below a configured relative installation path are accepted too. DevIntern:

- reads unresolved inline discussions and top-level human notes;
- ignores resolved discussions, system notes, bot users, blocked users, and its own replies;
- refuses fork MRs, identities below Developer access, and source branches the identity cannot push;
- verifies that the local `origin` is the exact MR project;
- revalidates the MR head SHA immediately before pushing; and
- replies with the result without resolving discussions or changing reviewer assignments.

`--no-push` leaves the local commit unpushed. `--no-reply` pushes the fix without posting GitLab replies or recording the notes as addressed. GitLab CI repair through `--ci-feedback` remains deferred.

## Registered-MR polling

The workspace worker polls only GitLab MRs that DevIntern successfully created and recorded. It does not scan projects, infer ownership from branch names, or discover repository-wide mentions.

Automatic addressing is triggered by a new unresolved discussion from either an assigned reviewer or a user whose effective project membership is Developer or higher. Permission lookup failures are treated as unknown and fail closed. Approvals are informational; unresolved actionable discussions are the feedback signal.

To narrow eligible actors further, configure a comma-separated username allowlist:

```bash
GITLAB_REVIEWER_ALLOWLIST=alice,bob
```

The poller reconciles merged, closed, deleted, and inaccessible MRs, paginates discussion results, honors API retry instructions, and applies bounded retry backoff when an addressing run fails or is deferred. Explicit adoption of pre-existing MRs is not supported yet.

## Keep GitLab branches current

Registered MRs can use the same guarded base-sync pipeline as GitHub pull requests. In `auto` conflict-resolution mode, the worker acts only when GitLab definitively reports `conflict` or `need_rebase`; checking, blocked, inaccessible, and unknown states never trigger an agent run. The MR must be same-project, the configured identity must have Developer access or higher, and its source branch must be writable.

You can also run synchronization directly:

```bash
devintern resolve-conflicts https://gitlab.com/group/project/-/merge_requests/123
```

The resolver fetches the actual target-branch tip, revalidates the MR state and head immediately before publication, and uses a normal fast-forward push—never a force push. Concurrent branch movement is deferred safely. Scheduled GitLab conflict windows remain deferred; a workspace configured with `conflict_resolution = "scheduled"` records no GitLab synchronization work until provider-neutral scheduling support lands. Manual resolution remains available in every mode.

## Repair GitLab CI failures

When `[workspace].ci_failure_fix = true`, the worker polls pipelines, jobs, and external commit statuses for registered GitLab MRs. It invokes the existing guarded `address-review --ci-feedback` repair path only for definitive required failures. Failed jobs marked `allow_failure` and manual, skipped, or canceled work are ignored. Missing, inaccessible, incomplete, or otherwise unrecognized CI data remains unknown—it is never counted as green.

Failure metadata and bounded excerpts from up to five failed job traces are passed to the agent. Before the repair begins, the worker revalidates the MR head SHA and the same-project writable-branch guard. Successful events deduplicate durably; unsuccessful attempts retain the existing `CI_FIX_MAX_ATTEMPTS` budget and post a GitLab MR note on exhaustion. A new head SHA grants a fresh retry budget.

## Hosted relay (recommended instant-event path)

The normal worker setup discovers every GitLab remote in `workspace.toml`, creates and tests a project hook, and receives reference-only events without exposing the worker host:

```bash
devintern worker init
# or reconnect all GitHub and GitLab code hosts later:
devintern worker connect
# focused GitLab repair/rotation:
devintern worker connect gitlab
```

Creating project hooks requires Maintainer or Owner access. DevIntern first tries `GITLAB_WEBHOOK_ADMIN_TOKEN`, then the normal code-host token (including the existing same-instance tracker-token fallback). A permission or network failure leaves polling active and continues with the other projects. Multiple projects, nested groups, GitLab.com, custom ports, relative Self-Managed installation paths, explicit SSH aliases, custom CA bundles, and integration-specific proxies use the same per-repository environment layers described above.

GitLab 19+ uses a Standard Webhooks signing token. Older Self-Managed versions automatically fall back to a legacy secret token when the instance rejects the newer field. These webhook credentials are generated for the route and never shown during successful setup or persisted locally. Reconnection updates only the exact remembered DevIntern hook, tests the replacement route end to end, and keeps the previous route briefly during rotation.

Relay deliveries contain only project/change references. The worker matches provider, instance, numeric project ID, project path, MR IID, and branch where supplied, then re-fetches discussions, MR state, mergeability, permissions, and CI state with `GITLAB_CODE_HOST_TOKEN`. It never trusts webhook payload state for an action. Polling continues as the fallback and correctness sweep.

To remove the exact remembered hooks and relay routes while retaining polling:

```bash
devintern worker connect gitlab --disconnect
```

Self-Managed GitLab must be able to make outbound HTTPS requests to `relay.devintern.com`. No inbound connectivity to the customer worker is needed. The relay sees the GitLab provider, instance URL, numeric project ID/path, MR IID or branch/head SHA when needed, event type, delivery ID, and timestamp. It never receives GitLab API tokens, source code, diffs, discussion text, CI logs, ticket bodies, or agent prompts/output.

## Direct project webhooks (advanced)

Polling remains the default and fallback. For lower-latency repo-local automation, explicitly configure a GitLab project webhook:

```bash
# GitLab 19+ Standard Webhooks signing token (preferred):
export GITLAB_WEBHOOK_SIGNING_TOKEN="whsec_<base64-encoded-32-byte-key>"
# Compatibility secret for older GitLab Self-Managed versions:
export GITLAB_WEBHOOK_SECRET="a-long-random-secret"
devintern webhook serve
```

Set the project webhook URL to `https://your-host.example/webhooks/gitlab`, configure the matching signing token (GitLab 19+) or legacy secret token, and enable **Comments**, **Merge request events**, **Pipeline events**, and **Job events**. Creating or editing a project webhook normally requires Maintainer or Owner access; the code-host API token used to process an event still needs the permissions documented above.

The endpoint verifies Standard Webhooks HMAC signatures with timestamp freshness checks or validates the legacy `X-Gitlab-Token` with a timing-safe exact comparison. If a signature header is present but invalid, DevIntern does not fall back to the legacy token. Deliveries are deduplicated by GitLab's delivery-scoped `webhook-id` or `Idempotency-Key`; the configured webhook UUID is never treated as a delivery ID. Only MRs already registered by DevIntern on the configured instance and project are eligible. Notes trigger the existing feedback reconciliation, closed or merged events stop the watch, definitive conflict states trigger guarded base sync, and failed pipeline/job events re-query CI before repair. Advisory jobs and canceled or ambiguous states remain non-actionable. Polling stays enabled, so missed deliveries and unsupported event variants are reconciled later.

Repository-wide GitLab mention discovery remains out of scope.

GitLab review, conflict-resolution, and CI-repair jobs share the workspace supervisor. Checkout preparation waits for admission, and running subprocesses receive cancellation when the worker stops them. Jobs cancelled before admission do not prepare a checkout.


## Batch processing with --query

Select multiple issues with familiar qualifiers — @devintern/code translates them to GitLab's [list issues](https://docs.gitlab.com/ee/api/issues.html#list-project-issues) filters. Queries are always scoped to `GITLAB_PROJECT`:

```bash
devintern --query "is:open label:bug" --create-pr
devintern --query 'is:open "login flow"' --create-pr
devintern --query "assignee:@me" --create-pr
```

Supported qualifiers: `is:open` / `is:closed`, `label:name` (repeatable), `assignee:@me` / `assignee:username`, `updated:>=<date>`. Anything else is free-text search.

The first 100 matching issues are processed in sequence.

## Story points estimation

GitLab issues have no estimation field, so `--estimate` runs in comment-only mode: the analysis is posted (or updated) as an issue comment with the suggested points, reasoning, risks, and unclear areas.

## Token scopes for Cloud vs. self-hosted

| Scope      | Needed for                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------ |
| `api`      | Full read/write access (recommended)                                                       |
| `read_api` | Read-only setups (fetching issues works; posting comments and label transitions will fail) |

Self-hosted tokens only exist on their own instance — a gitlab.com token cannot authenticate against your on-premises GitLab and vice versa.

## Limitations

- **Attachments:** files embedded in issue bodies (`/uploads/...` links) are downloaded for the agent using your token; other external links stay as references.
- **Status labels:** labels named in `settings.json` must already exist in the project. The error message lists available labels when one is missing.
- **Comments:** use `--skip-comments` to skip issue comments and label transitions for a run.
- **Merge-request automation:** creation, manual review addressing, registered-MR polling, automatic conflict resolution, CI repair, hosted relay delivery, and direct webhooks are experimental. Broad mention discovery and scheduled conflict windows remain unsupported.

## Troubleshooting

**"Missing required GitLab credentials"**

Ensure `GITLAB_TOKEN` and `GITLAB_PROJECT` are set in `.devintern-code/.env`.

**"GitLab API error (401)"**

Token rejected: check that it was created on the same instance as `GITLAB_BASE_URL`, has not expired, and carries the `api` scope.

**"Label \"In Progress\" not found in the project"**

Create the label in your project (Issues → Labels) or change the status names in `settings.json` to match existing labels.

**Old status labels pile up on issues**

Set `GITLAB_STATUS_LABELS` to the full list of status label names so transitions remove the previous status.
