# Connect source control and task trackers

Read only the provider guide relevant to the requested setup. The links below work for installed skills; in a DevIntern source checkout their counterparts are under `docs/code/`. Prefer the installed CLI's help when its capabilities differ from the docs.

## Source control has three separate connections

1. **Git transport:** the worker must fetch the registered remote and push when delivery requires it. A successful `git ls-remote` from the intended host/identity proves read access, not push permission. Check credential availability in the service environment; a terminal-only SSH agent or keychain session may not be available to an unattended service. Do not push a probe branch merely to validate setup.
2. **Code-host API:** local credentials read PR/MR data and perform requested API writes. Standard GitHub workspaces use local `GITHUB_TOKEN`; installing an App does not supply that token. Check access to the actual repository and permissions required by the requested features using provider APIs or an authenticated provider CLI. A CLI's own login does not prove DevIntern received the same credential. Inspect remote URLs without exposing embedded credentials.
3. **Event delivery:** the optional hosted relay delivers reference envelopes; the worker fetches content with its own local credentials. Polling remains a supported fallback. Do not require webhook/App setup for an explicitly polling-only installation.

For GitHub, follow [GitHub authentication](https://devintern.com/docs/code/configuration#github-authentication) and the [relay guide](https://devintern.com/docs/code/relay). Standard setup uses the central DevIntern AI App and local `GITHUB_TOKEN`; customer-owned App IDs/private keys and `devintern webhook serve` are advanced no-relay/custom-identity paths, not normal prerequisites. PR/content permissions depend on the requested operations; automatic CI repair additionally needs the documented Actions and commit-status read permissions.

For GitLab, distinguish [GitLab Issues and experimental code-host setup](https://devintern.com/docs/code/gitlab-integration). `GITLAB_TOKEN`/`GITLAB_PROJECT` configure the issue tracker. Experimental MR support has separate opt-in/code-host settings, including `DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST`, and may target a different instance. Do not assume configuring an issue tracker enables MR delivery or feature parity with GitHub. Use the guide's credential/profile and Self-Managed instructions. GitLab relay hook installation needs a usable admin token with Maintainer/Owner access to the selected project; it is separate from ordinary git access.

For other code hosts, consult [configuration](https://devintern.com/docs/code/configuration) and verify the installed provider supports the requested workflow; do not promise GitHub-style relay or review behavior for every remote.

## Configure the task source

Choose the tracker independently from the code host. Configure API access, the intended project/board/repository, a narrow query, and workflow states. Credential presence is not authentication: verify with a read-only API call in the intended scope. Inspect actual statuses/lists/labels before mapping them in the repository's `.devintern-code/settings.json`; do not guess names from another tracker. Browser-created workflow labels or provider settings should be limited to the requested integration.

| Source | Configuration and provider guide |
| --- | --- |
| Jira Cloud | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`; JQL and project-key status mappings. [Jira](https://devintern.com/docs/code/jira-integration). Do not assume Data Center support. |
| Linear | `LINEAR_API_KEY`; team and workflow states; structured queries use JSON `IssueFilter`. [Linear](https://devintern.com/docs/code/linear-integration). |
| GitHub Issues | `GITHUB_TOKEN`, `GITHUB_REPO=owner/repo`; issue queries, existing status labels, and `GITHUB_STATUS_LABELS`. The App cannot substitute for the token. [GitHub Issues](https://devintern.com/docs/code/github-issues-integration). |
| GitLab Issues | `GITLAB_TOKEN`, `GITLAB_PROJECT`, optional `GITLAB_BASE_URL`; project-scoped issue queries, existing labels, and `GITLAB_STATUS_LABELS`. [GitLab](https://devintern.com/docs/code/gitlab-integration). |
| Azure DevOps | `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_PROJECT`; Work Items read/write and WIQL queries. [Azure DevOps](https://devintern.com/docs/code/azure-devops-integration). |
| Asana | `ASANA_API_TOKEN`, project selection such as `ASANA_DEFAULT_PROJECT_GID`, and project section mappings. [Asana](https://devintern.com/docs/code/asana-integration). |
| Trello | `TRELLO_API_KEY`, `TRELLO_API_TOKEN`, board selection such as `TRELLO_DEFAULT_BOARD_ID`, and list mappings. [Trello](https://devintern.com/docs/code/trello-integration). |
| Markdown | `MARKDOWN_TASKS_DIR` for tracker mode; direct `.md` task paths need no tracker account. [Markdown tasks](https://devintern.com/docs/code/markdown-tasks). Check installed worker polling support rather than assuming every CLI task source is pollable. |

In multi-team workspaces, credentials belong to the acquiring team, while code-host access belongs to the destination repo. Preserve separate credentials even when two sources use the same provider. Team `env_file` paths are relative to the workspace home; inline team env overrides that file. The worker pins `TASK_TRACKER` to the acquiring team. Shared env may also contain namespaced `<TRACKER>_<TEAM>_<SETTING>` credentials; use the workspace guide's exact mapping rather than renaming existing secrets speculatively.

## Pair the relay when requested

Check `devintern worker connect --help`. Commands support `--workspace /path/to/workspace.toml`; tracker targets also support `--team <name>`. Use worker-scoped sign-in when needed. Bare `worker connect` handles GitHub/GitLab code hosts, not every tracker.

| Command | What it does |
| --- | --- |
| `devintern worker connect github` | Prints a short-lived authorization URL and waits for verified central GitHub App repository pairing. It can cover multiple unpaired workspace repos. |
| `devintern worker connect gitlab` | Creates or rotates managed project hooks and tests them with local GitLab credentials. |
| `devintern worker connect linear` / `asana` / `trello` / `azure-devops` | Registers that provider's webhook using its local credentials and configured project/board. |
| `devintern worker connect jira` | Prints a private ingest URL and Jira admin webhook instructions; it does not configure or validate Jira API access. |
| `devintern worker connect status` | Reports relay state and workspace repositories awaiting verification. |

When multiple teams use the same tracker, select `--team <name>` explicitly; with exactly one matching team the CLI can infer it. `--team` is not valid for GitHub/GitLab code-host pairing or status. GitHub Issues has no separate tracker connect step: distinguish its token/query setup from GitHub App pairing. Tracker registration does not replace local API credentials. Jira/Trello/Azure private ingest URLs act as authentication material; keep them out of committed files and summaries.

`devintern worker connect sentry --repo <registered-name>` is a separate, directly polled error-monitor setup, not relay pairing. Use the [Sentry guide](https://devintern.com/docs/code/sentry-integration) for the auth token, organization/project, and validation. A Sentry DSN cannot substitute for the polling token.

## Browser-assisted completion

Use CLI/API operations for deterministic setup and available browser tooling for the provider-only steps: GitHub App repository selection/authorization, Jira admin webhook configuration, or token settings when no suitable credential exists. Follow the URL emitted by the selected CLI flow rather than constructing a callback URL. On a remote worker, keep that CLI flow running while authorization completes in the user's browser.

Confirm the intended account, organization, repositories, and requested permissions from the page. Reuse existing access; avoid selecting all repositories when the request covers only specific repos. Let the user complete login, MFA, CAPTCHA, or organization-admin approval when required, then resume the same flow. When browser tooling is unavailable, give the specific remaining user action and continue independent local setup; do not claim authorization completed. Do not ask users to paste passwords, tokens, session cookies, or private webhook URLs into chat. Use secure local credential entry/storage and report only presence or validation results.

Complete provider changes within the user's requested integration scope. Account-wide permission expansion, removing existing integrations, or subscription changes need separate scope. Reconcile CLI exit status and `worker connect status` after browser completion. Also verify local API access; a successful browser authorization does not prove the worker can fetch content. If registration partly fails, inspect status and retry only the missing part rather than disconnecting/recreating healthy connections.
