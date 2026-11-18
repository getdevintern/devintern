---
title: "GitLab integration for DevIntern Code"
sidebarLabel: "GitLab Integration"
description: "Implement GitLab issues and experimentally create merge requests on GitLab.com or GitLab Self-Managed."
section: "Automation"
order: 6
sidebarHidden: true
dateModified: 2026-11-18
tags: ["gitlab", "gitlab-self-hosted", "devintern/code", "integration"]
---

# GitLab integration for DevIntern Code

GitLab works in two independent roles, on GitLab.com or GitLab Self-Managed:

- **Task tracker:** DevIntern Code reads a GitLab issue, checks that it is clear enough to implement, tracks progress with status labels, runs your coding agent, and posts the result back on the issue.
- **Code host (experimental):** DevIntern opens merge requests and follows up on review feedback, conflicts, and CI. The task can come from any tracker; the `origin` remote decides where the PR or MR is created.

## Prerequisites

- `@getdevintern/code` installed and a Git repository for your project
- A GitLab access token created on the same instance, with the `api` scope (`read_api` can read issues but cannot comment or change labels). A gitlab.com token does not work on a Self-Managed instance, or the reverse.

## Setup (issue tracker)

Set in `.devintern-code/.env`:

| Variable               | Required | Description                                                                                   |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `TASK_TRACKER`         | Yes      | `gitlab`                                                                                      |
| `GITLAB_TOKEN`         | Yes      | Personal access token from `/-/user_settings/personal_access_tokens` with `api` scope          |
| `GITLAB_PROJECT`       | Yes      | Project path (`group/sub/repo`) or numeric project ID                                         |
| `GITLAB_BASE_URL`      | No       | Instance root URL for Self-Managed (default `https://gitlab.com`); `http://` hosts are allowed |
| `GITLAB_STATUS_LABELS` | No       | Comma-separated status labels (e.g. `To Do,In Progress,In Review`); on each transition the others are removed |

## Run a task

Pass an issue number, `#number`, `group/sub/repo#123`, or full issue URL:

```bash
devintern 123 --create-pr
devintern https://gitlab.com/acme/team/webapp/-/issues/123 --create-pr
```

Batch runs accept familiar qualifiers, always scoped to `GITLAB_PROJECT`: `is:open` / `is:closed`, `label:name` (repeatable), `assignee:@me` / `assignee:username`, `updated:>=<date>`; other text is a free-text search. The first 100 matches run in sequence.

```bash
devintern --query "is:open label:bug assignee:@me" --create-pr
```

Files embedded in the issue (`/uploads/...`) are downloaded for the agent. Use `--skip-clarity-check` to skip the feasibility check and `--skip-comments` to skip comments and label changes. `--estimate` posts a comment only; see [Story Points Estimation](./story-points-estimation.md).

## Status mapping

Statuses map to labels. Create the labels in the project, then configure them in `.devintern-code/settings.json`, keyed by the project path. A status of `closed` or `done` closes the issue; moving back to an open status reopens it.

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

| Field              | When it is applied                                   |
| ------------------ | ---------------------------------------------------- |
| `inProgressStatus` | Implementation starts (after the feasibility check)  |
| `prStatus`         | A pull or merge request is created                   |
| `todoStatus`       | The run is incomplete, fails, or hits the turn limit |

## Worker notes

- [Worker polling](./worker.md#polling-mode) needs `GITLAB_TOKEN` and `GITLAB_PROJECT`. A label query such as `is:open label:intern` keeps matching after the MR, so the worker's local actioned marker stops re-implementation. See [Tickets already actioned after a PR](./worker-troubleshooting.md#tickets-already-actioned-after-a-pr).
- `devintern worker connect gitlab` creates and tests project hooks for instant MR events (see [Advanced](#advanced-merge-requests-and-webhooks)).

## Advanced: merge requests and webhooks

GitLab code-host support is **experimental**. Enable it with a separate code-host profile in `.devintern-code/.env`:

| Variable                                  | Description                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST` | `true` to enable MR creation and follow-up                                                         |
| `GITLAB_CODE_HOST_URL`                    | Instance root, including any relative path (omit for GitLab.com)                                   |
| `GITLAB_CODE_HOST_TOKEN`                  | Personal, project, or group token with API access. `GITLAB_TOKEN` is reused only when `TASK_TRACKER=gitlab` and `GITLAB_BASE_URL` is the same instance |
| `GITLAB_WEBHOOK_ADMIN_TOKEN`              | Optional Maintainer/Owner token used only to create relay hooks                                    |
| `GITLAB_CODE_HOST_ALIASES`                | Comma-separated SSH host aliases that differ from the browser hostname                             |
| `GITLAB_CODE_HOST_CA_FILE`                | PEM bundle for an internal certificate authority (do not disable TLS verification)                |
| `GITLAB_CODE_HOST_PROXY`                  | Proxy for GitLab requests; overrides `HTTP_PROXY` / `HTTPS_PROXY`                                  |
| `GITLAB_REVIEWER_ALLOWLIST`               | Comma-separated usernames allowed to trigger automatic review addressing                           |

`devintern PROJ-123 --create-pr` then opens a merge request on a GitLab remote. `--pr-target-branch` overrides the default branch; `PR_LABELS` applies only labels that already exist in the project. If MR creation fails, the pushed branch remains and the run reports the failure.

| Capability                                    | GitLab status                                                        |
| --------------------------------------------- | -------------------------------------------------------------------- |
| GitLab.com MR creation                        | Experimental                                                         |
| Latest stable GitLab Self-Managed MR creation | Experimental                                                         |
| Personal, project, and group access tokens    | Supported for API access                                             |
| Existing labels                               | Best-effort; missing labels are skipped                              |
| Manual `address-review`                       | Experimental; same-project writable branches only                    |
| Registered-MR polling                         | Experimental; DevIntern-created MRs only                             |
| Conflict/base synchronization                 | Experimental; `auto` mode and manual command                         |
| CI repair                                     | Experimental; registered MRs through polling, relay, or direct webhooks |
| Hosted relay                                  | Experimental; automatic project hooks, no worker inbound port        |
| Direct project webhooks                       | Experimental; repo-local server only                                 |
| Repository-wide mentions                      | Deferred                                                             |

Other GitLab REST API v4 versions work best-effort with a compatibility warning. Scheduled conflict windows (`conflict_resolution = "scheduled"`) are not supported for GitLab yet.

**Review feedback.** Run `devintern address-review <MR URL>` to address unresolved discussions and human notes (`--no-push` keeps the commit local; `--no-reply` skips replies). The worker also polls MRs that DevIntern created and addresses new unresolved discussions from assigned reviewers or members with Developer access or higher. Fork MRs and branches the token cannot push are refused.

**Conflicts and CI.** In `auto` conflict mode the worker syncs a registered MR with its target branch when GitLab reports `conflict` or `need_rebase`; run `devintern resolve-conflicts <MR URL>` manually anytime. It never force-pushes. With `[workspace].ci_failure_fix = true`, the worker repairs required failed pipelines on registered MRs, within the `CI_FIX_MAX_ATTEMPTS` budget.

**Hosted relay (recommended).** `devintern worker init` or `devintern worker connect gitlab` creates and tests a project hook for every GitLab remote in the workspace. It needs Maintainer or Owner access (via `GITLAB_WEBHOOK_ADMIN_TOKEN` or the code-host token). Self-Managed instances need only outbound HTTPS to `relay.devintern.com`. `devintern worker connect gitlab --disconnect` removes the hooks and keeps polling. See [Relay](./relay.md) for what the relay sees.

**Direct project webhooks.** For a repo-local listener without the relay, set a secret and run `devintern webhook serve`:

```bash
export GITLAB_WEBHOOK_SIGNING_TOKEN="whsec_<base64-encoded-32-byte-key>"   # GitLab 19+
export GITLAB_WEBHOOK_SECRET="a-long-random-secret"                        # older Self-Managed
devintern webhook serve
```

Point the project webhook at `https://your-host.example/webhooks/gitlab` with the matching token, and enable **Comments**, **Merge request events**, **Pipeline events**, and **Job events**. See [GitHub Webhooks and PR Automation](./github-integration.md) for exposing the listener over HTTPS. Polling stays on as the fallback.

## Troubleshooting

| Symptom                                       | Fix                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Missing required GitLab credentials`         | Set `GITLAB_TOKEN` and `GITLAB_PROJECT`.                                                              |
| `GitLab API error (401)`                      | The token is from another instance than `GITLAB_BASE_URL`, has expired, or lacks the `api` scope.     |
| `Label "In Progress" not found in the project` | Create the label (Issues → Labels) or change the names in `settings.json`; the error lists existing labels. |
| Old status labels pile up                     | Set `GITLAB_STATUS_LABELS` to the full list of status labels.                                          |
| Relay hook setup fails                        | The token needs Maintainer or Owner access; polling keeps working meanwhile.                           |
