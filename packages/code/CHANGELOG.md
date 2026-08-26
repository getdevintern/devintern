# @devintern/code Changelog

## [Unreleased]

## [2.5.0] - 2026-08-26

Recurring scheduled automations, Supporter licenses covering multi-repo workspace mode, anonymous CLI analytics, and pickup/sync/JSON robustness fixes.

### Added

- **Recurring scheduled automations**: `.devintern-code/automations.toml` (or `[[automations]]` in the workspace file) runs a prompt on an interval or cron through the normal task pipeline — markdown occurrence file → plan / implement / `--create-pr` / review. Independent of any tracker, so an automation-only worker can run with no `--query`. Occurrence files land next to project state, or under the workspace home in fleet mode
- **Anonymous CLI usage analytics**: one fire-and-forget `cli_run` event per invocation (CLI version, OS/arch, tracker type, run mode, task count, and feature flags only — never task content, code, repo names, or credentials). Opt out with `DEVINTERN_TELEMETRY_DISABLED=1` or `analytics.enabled: false` in `.devintern-code/settings.json`. A missing `POSTHOG_API_KEY` at build time permanently disables analytics

### Changed

- **Workspace (multi-repo) mode no longer requires a Team subscription**: any valid automation entitlement — including the Supporter one-time license (`solo-automation`) — now runs `devintern worker` in workspace mode, matching published pricing where Supporter covers automation across your own repos. The team-tier gate was removed after the existing automation license check; unlicensed and invalid-license runs still fail as before, and grace-window cached solo entitlements now qualify too

### Fixed

- **Jira and Azure DevOps worker pickup no longer sticks after the first attempt**: the worker dedupes ready tasks by `(key, updated)`. Jira enhanced JQL search (`GET /rest/api/3/search/jql`) omitted `fields`, and Azure WIQL search batch-fetched titles without `System.ChangedDate`, so both recorded an empty stamp and never retried after a failed run — even when the ticket was edited. Jira search now requests `updated` (and the other issue fields used for routing); Azure search now fetches `System.ChangedDate`. The worker also logs when every matching task is skipped as already processed, and warns when search results have no update stamp, so this is visible in the worker log instead of looking like the poller is idle
- **Failure comments say how to retrigger pickup**: incomplete-implementation, crash/interrupt, and failed-feasibility comments on every hosted tracker (Jira, Linear, GitHub Issues, Azure DevOps, Asana, Trello) now tell the user to edit the description, post a comment, or delete the bot comment so the worker (or next `--query` run) will pick the ticket up again. Markdown files do not receive tracker comments. The previous Jira incomplete text only said "update the description and retry."
- **Mangled agent JSON is recovered instead of failing the run**: `parseAgentJson` now slices balanced `{...}` objects with a string-aware brace matcher, repairs raw control characters and unescaped quotes inside string values, and accepts a stray extra `}` or literal `\n` after the last value — shapes grok and opencode actually emit
- **PR base-sync no longer skips conflicting PRs or loops forever**: eligibility uses GitHub's `mergeable_state` (`dirty` / `behind`) instead of comparing against a stale `base.sha`; the resolver merges the fetched base tip; three consecutive defers exhaust the event; hung `resolve-conflicts` subprocesses are killed after `WORKER_RESOLVE_TIMEOUT_SECONDS`
- **Agent PRs on repos the worker no longer manages are unwatched**: review polling is scoped to the detected GitHub slug (single-repo) or `workspace.toml` repos (fleet). Foreign `agent_prs` rows are closed at startup and skipped on every tick, so a renamed/transferred repo cannot fail auth forever
- **Transient PR-creation failures retry, and GitHub create is idempotent**: `fetchWithRetry` treats DNS/connect/`fetch failed` as transient; `PRManager.createPullRequest` retries transport failures; a GitHub 422 for an already-open PR on the head branch is treated as success so a blip after push no longer leaves the ticket In Progress with no PR
- **Scheduled automation task files resolve through project config-dir traversal**: occurrence markdown is written into the nearest `.devintern-code` walking up from the run cwd (workspace automations use the workspace home), so a worker launched from a subfolder does not create a stray nested config directory

## [2.4.0] - 2026-08-22

The onboarding release: `devintern doctor`, an extended init wizard with post-setup checks, first-run rescue when running a task in an unconfigured project, and upgrade-in-place for existing setups.

### Added

- **`devintern doctor` readiness command**: shared readiness checks (Bun, git, agent CLI, tracker credentials, sign-in session, license entitlement) printed as a checklist with fix hints per failing row; exits non-zero so scripts and CI can gate on it
- **Extended init wizard onboarding**: interactive `devintern init` now finishes with post-setup — agent CLI detection (install hint when none), an inline sign-in offer, and a readiness summary over the freshly written config
- **First-run guided setup**: running `devintern <TASK-KEY>` in an unconfigured project no longer dies with a list of missing env vars — in an interactive terminal it offers the init wizard inline, reloads the environment after setup completes, and proceeds with the run (non-interactive sessions keep the old error path)
- **Init upgrade flow**: re-running `devintern init` over an existing configuration now offers to update the current tracker's credentials (stored values become Enter-to-keep defaults), switch trackers (GitHub PR token carries over), or exit; changes are merged into `.env` while preserving comments, custom vars, and skipped optionals
- **Zero-account markdown tracker leads the init menu**: markdown files need no credentials, so they appear first with a "quickest way to try" hint, letting evaluators reach a first successful run without wiring up Jira/GitHub
- **`AGENT_MODEL` applies to every agent spawn**: implementation runs, plan-implementation retries, webhook reviews, review addressing, the auto-review loop, git hook fixes, and analysis spawns all honor the configured model
- **Sentry error tracking**: crash and unhandled-error reporting via a baked-in DevIntern DSN; opt out with `SENTRY_DISABLED=1`

### Fixed

- **Hook-fix verification after a successful push**: if HEAD already matches `origin/<branch>`, skip the pre-push `--dry-run` (and the follow-up no-op `git push`). Re-running the hook suite can flake — a 30s CLI test timeout previously aborted PR creation for a branch that was already on the remote, with a misleading "didn't amend" error
- **CLI argument tests no longer hang on a live tracker host**: parse-only CLI tests point Jira, Linear, and Trello traffic at a closed local port and disable fetch retries (`DEVINTERN_FETCH_MAX_RETRIES=0`), so a slow remote lookup cannot burn the 30s bun timeout and fail pre-push
- **Default branch detection**: repository automations now ask the remote for its authoritative default branch before checkout or fetch operations, avoiding failed `master` attempts for repositories whose default is `main` (and supporting custom default branch names). Cached `origin/HEAD` remains an offline fallback. An explicit `--pr-target-branch master` (or `main`) that is missing on the remote now falls back the same way, so copied cron examples no longer `git fetch` a doomed ref before switching to the real default
- **Structured agent responses**: feasibility checks now accept the valid bare JSON commonly returned by Codex instead of requiring a Markdown code fence. Feasibility, estimation, and auto-review share brace-aware extraction that also tolerates narration and ignores unrelated braces in prose
- **False max-turns / usage-limit detection in Codex output**: turn-limit diagnostics are matched as complete lines and harnesses that cannot pass `--max-turns` are skipped, so Codex tool transcripts quoting this repo's own source no longer classify runs as exhausted
- **Jira comments posted as ADF**: markdown comment bodies are converted to Atlassian Document Format before posting, so formatting renders correctly instead of appearing as raw text
- **Failure feedback on the ticket**: timeouts, usage limits, and SIGTERM/SIGINT used to leave the task stranded In Progress with no PR and no feedback; a comment now explains what happened and the ticket moves back to To Do so the next scheduled run can retry it
- **`.devintern-code` scaffolds at the repository root**: running the init wizard from a subdirectory of a monorepo created the config folder inside that subdirectory; it now resolves against the enclosing git root
- **Incomplete setups keep guiding init**: an existing `.devintern-code` folder without a `.env` used to make both the wizard and scaffold refuse outright; they now complete the folder in place (credentials are never overwritten)

## [2.3.2] - 2026-08-18

### Fixed

- **Linear issue lookup**: fetching a task like `DAN-6` no longer fails with `Field "identifier" is not defined by type "IssueFilter"`. Lookups now use Linear's `issue(id:)` query, which accepts both identifiers and UUIDs
- **Multiple Linear issue keys in one CLI run**: `devintern dan-6 dan-7 dan-8` now normalizes each argument independently (uppercase, unwrap linear.app URLs) and fetches them in order
- **Headless Grok / TUI harnesses during hook-fix and review**: hook fixer, `address-review`, auto-review, and the webhook review runner now pass the prompt on the command line (`grok -p`, `kimi --prompt`, positional for Codex/Opencode/Cursor) and ignore stdin. Those paths previously piped the prompt, so TUI-first CLIs opened an interactive session and died with `Device not configured (os error 6)` / ENXIO when no TTY was attached

## [2.3.1] - 2026-08-12

### Fixed

- **Codex CLI approval flag**: unattended Codex runs now use the current `approval_policy` config override instead of the removed `--ask-for-approval` flag, so tasks no longer exit before execution

## [2.3.0] - 2026-08-10

The workspaces release: one `devintern worker` daemon now drives a fleet of repos — fleet-wide review polling, mention sweep, relay routing, and guided `workspace init`/`import` setup.

### Added

- **Workspace mode — one daemon drives the fleet**: `devintern worker` grows a workspace mode that auto-detects `~/.devintern/workspace.toml` (`--workspace [path]` explicit, `--no-workspace` opts out; `--listen` stays single-repo and refuses to combine). Gated by the team-automation license after the existing automation license check. One fleet `TaskPollingAcquirer` runs detect-then-evaluate with the workspace query, then routes → clone/fetch → per-task worktree → repo run lock → `runTaskViaCli(taskKey, args, { cwd, env })` → worktree cleanup. Ambiguous/unrouted tasks are recorded via `RoutingSkipStore` and counted as handled so the dedupe keeps them out until the task changes (never guesses). The workspace `.env` + `TASK_TRACKER` + `WEBHOOK_QUEUE_DB` apply to the parent process, so the tracker client, dashboard (`--ui`), and run records all follow the fleet DB with no pipeline changes. Serial by default; per-repo locks make parallel-across-repos safe to add later (config key reserved, not built)
- **Fleet reviews, mention sweep, and relay routing**: a fleet-wide `ReviewPollingAcquirer` watches PRs across repos, a `MentionSweepAcquirer` per GitHub repo surfaces bot mentions on any PR, and a `RelayAcquirer` re-runs the fleet query when `WORKER_RELAY_URL` + `LICENSE_KEY` are set in the workspace `.env`. `createFleetAddressPr` clones/fetches and runs `address-review` as a subprocess with per-repo env. Mention-triggered fleet runs are permission-gated in the handler (write/maintain/admin required, fails closed) since `devintern address-review` performs no gating of its own; single-repo mode keeps its existing in-pipeline gate
- **`devintern workspace init` and `devintern workspace import`**: `init` scaffolds `~/.devintern/workspace.toml` (commented template) + shared `.env`, refusing to overwrite. `import` (run inside a repo) turns the origin remote into a `[[repos]]` entry (unique filesystem-safe name; `default_branch` from `origin/HEAD` when it differs from the workspace default), merges the repo's `.devintern-code/.env` keys into the shared `.env` with conflicting values demoted to that repo's inline `[repos.env]` (nothing silently overwritten), and seeds a starter routing rule from `JIRA_DEFAULT_PROJECT`/`LINEAR_DEFAULT_TEAM_KEY` when unclaimed. Idempotent re-imports append new entries as text so hand-written comments survive, and the result is round-tripped through `loadWorkspaceConfig` before being written. No license gate on config management — enforcement stays on the worker's workspace mode

## [2.2.3] - 2026-08-06

### Fixed

- **Cursor under nono/srt can write session chats**: sandboxed `cursor-agent` runs now get write access to `~/.config/cursor` (in addition to `~/.cursor`), so chat `mkdir` no longer fails with `EACCES`
- **lefthook commits work under nono**: the nono provider grants `--allow-file /dev/ptmx` so git hooks that allocate a PTY are not blocked
- **Antigravity nono pack is selected when installed**: `AGENT_HARNESS=antigravity` now loads the `antigravity` pack profile (and grants `~/.gemini` state writes); doctor/docs list `antigravity` alongside the other packs
- **Hook-fix fallback commit no longer hangs on an editor**: when the agent fixes pre-commit issues but leaves the tree dirty, DevIntern's manual `git commit --no-verify` now always passes `-m` (and stages with `git add -A`). Previously omitting `-m` opened `GIT_EDITOR` and blocked unattended runs indefinitely

## [2.2.2] - 2026-08-06

### Fixed

- **Linux desktop terminals no longer trip the automation license gate**: systemd user sessions inherit `INVOCATION_ID` / `JOURNAL_STREAM` / `SYSTEMD_EXEC_PID` into every terminal (Ghostty, Cursor, etc.), so interactive runs were falsely treated as unattended. Detection now requires `CI`, a direct systemd `ExecStart` (`SYSTEMD_EXEC_PID` matching this process), or a real `.service` cgroup — not desktop `.scope` units

## [2.2.1] - 2026-08-03

### Changed

- **Analysis runs temporarily skip harness read-only mode**: feasibility/clarity and estimation spawns always use the default unattended path for now. Several harnesses (notably Cursor ask mode) were returning empty or non-JSON stdout under native read-only/plan modes. The prefer-readonly + fallback path remains in `lib/analysis-mode.ts` behind `PREFER_READONLY_ANALYSIS` for a later re-enable

### Fixed

- **Markdown feasibility checks use the assessment prompt**: markdown tracker runs were feeding `task-details.md` (an implement prompt) into the clarity agent, so the response was prose instead of the required JSON assessment and the parse always failed
- **Branch cleanup no longer destroys run records or user work**: `queue.db` now resolves through the nearest `.devintern-code` directory (same traversal as `.env`), `git clean` excludes that directory, and the database is kept out of git via `.git/info/exclude`. Uncommitted local changes are stashed with a labelled entry before feature-branch prep instead of being hard-reset away after a pull refusal

## [2.2.0] - 2026-07-31

The server-automation release: a single `devintern worker` daemon that picks up ready tasks, reacts to PR reviews, and reports on itself through a local dashboard — plus OS-level sandboxing for every agent spawn.

### Added

- **`devintern worker`: one daemon for unattended automation**. Replaces the standalone webhook server as the entry point for server-side runs: a worker-specific single-instance lock (manual CLI runs are never blocked), an automation-license gate checked at startup, an acquirer registry, and graceful `SIGINT`/`SIGTERM` shutdown. `--listen` folds the webhook server into the daemon; `devintern serve` remains as a deprecated alias. Mention-triggered automation is now permission-gated: the review or comment author must have push access (write/maintain/admin) to the repo, checked via the collaborators API and failing closed — previously any commenter on a public repo could direct the agent with an `@mention`
- **Polling mode — pick up ready tasks with no webhooks, on all seven trackers**: `devintern worker --query '<query>'` (or `WORKER_TASK_QUERY`) runs a detect-then-evaluate loop — a cheap per-tracker change detector answers "did anything change since the cursor", and only then does the worker re-run your query to find ready work. Detectors ship for all seven trackers: relative-window queries for Jira (JQL), Linear, GitHub Issues, and Azure DevOps (WIQL), the board-actions feed for Trello, the Events API with sync tokens for Asana, and an mtime scan for markdown. Work is deduped by (task key, updated stamp), so a failing task cannot loop every tick and re-enters only when the ticket actually changes; cursors persist per source, so a crash mid-tick re-detects on restart without double execution. Tasks run sequentially through the normal CLI pipeline as a subprocess (`WORKER_TASK_ARGS`, default `--create-pr`), so locks, licensing, transitions, PR creation, and run records all apply unchanged
- **Review polling on the agent's own PRs**: the worker watches the PRs it opened and runs `address-review` when a human requests changes or leaves new inline comments — no `@mention` needed on the agent's own work. Uses ETag conditional requests (304s are rate-limit-free), so watching many PRs at 60-second intervals stays cheap; closed and merged PRs are unwatched automatically, and one failing PR does not stop the others. On by default in polling mode with GitHub credentials, off under `--listen` where webhooks already deliver reviews
- **Repo-wide `@mention` sweep**: two since-cursor requests per tick (regardless of open-PR count) surface bot mentions on *any* PR, not just the agent's own, feeding the same review pipeline the webhook server uses. Fork PRs without `maintainer_can_modify` are skipped with an explanatory comment, pushes stay fast-forward-only so a human moving the branch is never overwritten, and mentions predating the first worker start are not dug up. Requires a resolvable bot identity (GitHub App auth); dormant otherwise
- **Local observability dashboard**: `devintern dashboard` (or `devintern worker --ui`) serves run history, per-run stage timelines, and aggregate stats from `.devintern-code/queue.db` over a localhost JSON API, with the React UI bundled into the published package. Stores open read-only for the dashboard, so it reads safely alongside a live worker and standalone after it stops
- **Structured run records**: every task attempt now writes a run row plus per-stage records (feasibility verdict, implementation harness/duration/incomplete detection, auto-review iterations and approval, terminal outcome — succeeded / failed / deferred on usage limits / escalated / abandoned) and the created PR's repo, number, and URL. The implementation stage also stores an excerpt of the agent's own report, so the dashboard shows *what* was implemented or why a run escalated. Recording is best-effort and never fails a run; stage detail is capped so transcripts cannot bloat the database
- **OS-level agent sandboxing**: every agent spawn can now be wrapped in an isolation layer via `AGENT_SANDBOX` (`.devintern-code/.env`, default `none`) or the per-run `--sandbox <name>` flag. Five providers: `native` (the harness's own built-in sandbox: Claude Code's sandboxed Bash tool, Codex's `--sandbox workspace-write`, zero install), `nono` and `srt` ([Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime), process wrappers that work with any harness), `docker` ([Docker Sandboxes](https://www.docker.com/products/docker-sandboxes) via the standalone `sbx` CLI), and `smolvm` (microVM with in-VM browser support). `AGENT_SANDBOX=auto` picks the best available option (`native` > `nono` > `srt`; `docker`/`smolvm` need per-user setup and are never auto-selected) and warns once if nothing is available; an explicitly requested but unavailable or harness-incompatible provider fails the run instead of silently running unsandboxed. Tunable via `AGENT_SANDBOX_WRITABLE_PATHS`, `AGENT_SANDBOX_ALLOWED_DOMAINS`, and `AGENT_SANDBOX_NONO_PROFILE`.
- **`devintern sandbox` doctor command**: reports which providers are installed, the one-time setup steps each still needs, what `auto` would pick, and a "next run" line stating exactly what the current configuration will do (including a precise reason and non-zero exit code when the configured provider would make the run fail, so scripts and CI can gate on it).

- **Automatic merge-conflict resolution on the agent's PRs**: when a watched PR conflicts with its base branch, the worker merges the base in; conflicted merges are resolved by the agent (with a check that nothing is left unmerged before committing), then pushed without force. Failed resolutions abort the merge, comment on the PR, and retry only after the branch or base moves. Manual equivalent: `devintern resolve-conflicts <pr-url>`

- **`devintern worker init`**: guided server-automation setup. Prompts for the ready-tasks query and validates it against your tracker with a live dry run, chooses polling vs. webhook mode (generating a `WEBHOOK_SECRET` when needed), checks the automation license up front instead of failing on the first unattended poll, writes the `WORKER_*` configuration into `.devintern-code/.env`, and can emit a ready-to-install systemd service file

- **Comment-unlocked retries**: a task whose previous attempt was reported incomplete now re-runs when any new comment is posted on the ticket, not only when the description is edited. Deleting the bot's incomplete comment also unlocks a retry.
- **Retry-aware prompts**: re-runs tell the agent which attempt this is, why the previous attempt stopped (from run records), and which comments are new since then.
- **`--force` flag**: re-run a task locally even if a previous attempt was reported incomplete and the ticket is unchanged (manual use only; do not add to `WORKER_TASK_ARGS`).
- **Attempt numbers**: run records (`runs` table) now carry a per-task attempt number; branch probing also checks `origin/*` refs so fresh clones don't collide with a previous attempt's remote branch.

### Changed

- **Durable state moved to `.devintern-code/queue.db`**: the webhook queue database moves out of `/tmp/devintern-webhooks/queue.db` (wiped on every reboot); a one-time migration copies the legacy database on first start, and `WEBHOOK_QUEUE_DB` still overrides the location. The same database now also holds worker cursors, the agent PR registry, run records, and retry state. Add `.devintern-code/queue.db` to `.gitignore` if you whitelist the `.devintern-code` directory
- **`devintern serve` is deprecated** in favor of `devintern worker --listen`; the old command still works and prints a deprecation notice
- **Retry bookkeeping moved to `.devintern-code/queue.db`** (`task_retry_state` table). The old `incomplete-task-description.txt` marker under the output directory is no longer written or read; pre-existing files are ignored, so the first pickup after upgrading may re-run one previously-skipped task (it then posts a fresh incomplete comment and is gated again). Everything under `DEVINTERN_OUTPUT_DIR` is now purely a debug artifact.

### Fixed

- **Review fetch no longer shallows the project clone**: preparing the review worktree used `git fetch --depth=1`, which marks the entire repository shallow (`.git/shallow`) and silently breaks `merge-base` and merges in the user's own checkout. The fetch is now a normal incremental fetch; repos already shallowed (by older versions or CI checkouts) are unshallowed on demand before conflict-resolution merges
- **Webhook redeliveries no longer re-run a review**: GitHub delivery ids are recorded in a `processed_events` table and deduped, with retention independent of the event rows; startup also prunes expired dedupe ids and stale failed events

## [2.1.1] - 2026-07-13

### Added

- **Interactive `devintern init` wizard**: running `init` in a terminal now starts a guided setup that asks which task tracker you use, links directly to the provider's token-creation page plus the matching setup guide on devintern.com, and validates the connection (retry / edit / skip) before writing `.devintern-code/.env`. `--yes` / `--no-interactive` (or piped stdin) keeps the old template-scaffold behavior for scripted use
- **Sibling-config fast track**: if `.devintern-pm/.env` is already configured in the same project, `devintern init` detects it and offers to reuse those tracker credentials, skipping the tracker menu and credential prompts (only asking for steps the existing config doesn't cover) before still re-validating the connection. `devpm init` does the same in reverse, reading `.devintern-code/.env`

### Fixed

- **`AGENT_CLI_PATH` regression**: the init wizard was writing an active `AGENT_CLI_PATH=claude` line into generated env files, overriding the PATH-detection default. Generated files now ship it commented out again, matching the documented "leave unset" guidance

## [2.1.0] - 2026-07-11

### Added

- **Read-only analysis runs**: internal analysis-only agent spawns (feasibility/clarity check, story point estimation) now use the harness's native read-only or plan mode when the CLI can enforce one (claude-code, codex, cursor, grok, opencode), and are never combined with permission-skip flags. Harnesses without native enforcement keep the previous unattended behavior, and a failed constrained run falls back to it automatically. `AGENT_ANALYSIS_ALLOWED_TOOLS` (comma-separated, harness tool naming) extends the analysis tool allowlist, e.g. to MCP servers. devpm task generation applies the same policy

### Changed

- **Antigravity CLI harness**: `AGENT_HARNESS=antigravity` (binary `agy`) replaces the retired Gemini CLI integration. Headless runs use `agy -p` with optional `--dangerously-skip-permissions`. Legacy `AGENT_HARNESS=gemini` (and `agy`) still resolve to Antigravity with a deprecation warning; the dead `gemini` binary is not spawned. Prefer `AGENT_CLI_PATH` / `ANTIGRAVITY_CLI_PATH` / `AGY_CLI_PATH` over `GEMINI_CLI_PATH`. Antigravity has no headless read-only mode, so analysis runs use the default unattended path on this harness. Install: https://antigravity.google/docs/cli/install

### Fixed

- **Prompt delivery to agent CLIs**: the prompt is now passed on the command line (via each harness's prompt flag) instead of stdin, so TUI-first CLIs (grok, kimi, goose, qwen) no longer fail with "Device not configured" or hang waiting for a terminal in headless runs, and opencode no longer blocks on an unused stdin pipe
- **Partial commits from monorepo subdirectories**: automatic commits now stage the entire repository (`git add -A`) instead of only the launch directory, and a post-commit guard verifies the working tree is clean — sweeping hook-generated files into the commit, or failing loudly — so a run can no longer push a partial commit or open a PR missing most of the implementation

## [2.0.0] - 2026-07-09

The FSL release. The source is available under FSL-1.1-Apache-2.0, interactive use is free with no license or signup, and unattended automation is licensed via Supporter, Team, or Business plans.

### Added

- **Linear, GitHub Issues, Azure DevOps, and Asana trackers**: full lifecycle support (fetch, status transitions, implementation summary comments), bringing supported trackers to seven: Jira, Linear, Trello, Asana, Azure DevOps, GitHub Issues, and local markdown files
- **`--query` for Trello and Markdown trackers**: batch selection now works across all trackers (`--jql` remains as a deprecated alias)
- **Entitlement grace window**: when the license server is unreachable (network error or 5xx), a cached last-known-good entitlement is honored for 72 hours so an outage never blocks paying customers' automation

### Changed

- **License**: switched to the Functional Source License (FSL-1.1-Apache-2.0); each release converts to Apache-2.0 after two years
- **Licensing model (breaking)**: interactive runs no longer perform any license check; unattended execution (systemd, cron, CI, webhook server) requires an automation license (Supporter, Team, or Business). Pre-FSL product SKUs are no longer recognized; existing perpetual license holders receive equivalent entitlements

### Removed

- **14-day trial (breaking)**: interactive use is free forever and needs no trial; unattended automation is covered by the subscription's 30-day money-back guarantee instead

## [1.2.0] - 2026-06-01

### Added

- **Trello support**: Implement tasks from Trello cards (short link, full URL, or card ID)
  - Fetch card details and comments, post feasibility and implementation comments
  - Move cards between lists via `settings.json` (`inProgressStatus`, `prStatus`, `todoStatus`)
  - Set `TASK_TRACKER=trello` with `TRELLO_API_KEY` and `TRELLO_API_TOKEN`

- **Multi-tracker project settings**: Tracker-specific sections in `settings.json` (`jira`, `trello`, etc.)

- **Generic CLI flags**: `--query` replaces `--jql`; `--skip-comments` replaces `--skip-jira-comments` (legacy flags still work with deprecation warnings)

### Changed

- **Default `--max-turns`**: Implementation now defaults to **500** turns (was 25). Clarity checks still use 10 turns.

### Removed

- **`--no-agent` flag**: DevIntern always runs the full workflow (clarity check → agent → commit/PR) after fetching task details. Use `--skip-clarity-check` or `--no-git` when you need to limit automation scope.

### Fixed

- **Agent never ran by default**: Fixed a regression where the CLI checked `options.claude` after the flag was renamed to `--no-agent`, causing fetch-only exits with manual instructions.

- **Trello board ID lookup**: Settings keyed by board short link now resolve correctly when cards return the internal 24-character board ID.

## [2.3.0] - 2026-02-28

### Added

- **Estimation Mode**: New `--estimate` flag runs Claude to estimate story points for JIRA tasks
  - Fibonacci-scale estimates (1–21) with confidence level, reasoning, risks, and unclear areas
  - Auto-discovers and sets the story points field in JIRA
  - Posts rich estimation comment to JIRA; low-confidence estimates ask for more details
  - Skips tasks created less than 24 hours ago
  - Per-project `storyPointsField` override in `settings.json`
  - Example: `devintern --estimate --jql "project = PROJ AND status = 'To Do'"`

- **Smart Re-Estimation**: Re-estimates tasks updated since the last estimate
  - Compares issue `updated` timestamp against estimation comment date
  - Updates existing comment in place instead of creating duplicates

## [2.2.0] - 2026-02-28

### Added

- **Plan-Implementation Pipeline**: Detects when Claude creates a plan instead of implementing, then automatically re-runs Claude to implement it

- **Claude Subprocess Timeout**: Configurable timeout (default: 60 min, via `AGENT_HARNESS_TIMEOUT_MINUTES`) prevents queue blocking

### Changed

- **Webhook Review Flow**: Faster webhook responses, review iterations squashed into single commit, removed noisy reply comments

### Fixed

- **Worktree Branch Handling**: Fixed branch switching, stale worktree state, and recovery when Claude switches branches during review

## [2.1.0] - 2026-01-23

### Added

- **Automatic PR Self-Review Loop**: New `--auto-review` flag enables iterative self-improvement of PRs
  - Claude reviews its own PR diff and identifies issues by priority (critical/high/medium/low/info)
  - Automatically addresses medium+ priority issues in iterative cycles
  - Configurable max iterations (default: 5) via `--auto-review-max-iterations`
  - Saves review artifacts (feedback.json, prompts) to output directory for debugging
  - Integrated into webhook server via `WEBHOOK_AUTO_REVIEW=true`

- **Auto-Review Trigger Phrases**: Webhook server responds to simple trigger phrases in reviews
  - Supported phrases: "enhance", "improve", "polish", "refine", "clean up", "self-review", etc.
  - Example: Post a review with just `@devintern enhance` to trigger auto-review loop
  - Skips normal review flow and runs self-review directly

- **Exponential Backoff with Jitter**: All HTTP API calls now have robust retry logic
  - Automatic retries on 5xx errors and network failures
  - Exponential backoff (1s → 2s → 4s → 8s) with random jitter to prevent thundering herd
  - Configurable max retries (default: 3)

- **Detailed Issue Logging**: Auto-review loop now logs each issue with priority and location
  - Format: `[priority] (file:line): issue description`
  - Makes it easy to see what issues will be addressed in each iteration

### Changed

- **Webhook Auto-Review Flow**: Restructured to validate hooks and batch changes before pushing
  - Runs pre-push hook validation locally before any push
  - Auto-review runs with `skipPush: true` to accumulate all improvements
  - Re-validates hooks after auto-review changes
  - Single push at the end with all review fixes and auto-review improvements

## [2.0.0] - 2025-12-24

### Breaking Changes

- **Bun Runtime Required**: The tool now requires [Bun](https://bun.sh) runtime instead of Node.js
  - Install via `bun install -g @devintern/code` (not npm)
  - Run directly via `bunx @devintern/code` or after global install

### Added

- **Webhook Server for Automated PR Reviews**: New `serve-webhook` command that automatically addresses PR review feedback
  - Listens for GitHub webhook events and processes `changes_requested` reviews when bot is mentioned
  - SQLite-based persistent queue (`bun:sqlite`) for crash-resilient processing with automatic recovery on restart
  - Dedicated worktree at `/tmp/devintern-review-worktree/` provides isolation from main repository
  - Automatically detects and installs project dependencies (supports bun, pnpm, npm, yarn, poetry, uv, pip)
  - Commits attributed to GitHub App bot account (`app-name[bot]`) for clear audit trail
  - Fetches complete review context including all comments and conversation threads
  - Posts implementation summaries as PR review replies
  - Configurable via `WEBHOOK_PORT`, `WEBHOOK_SECRET`, and other environment variables

- **Address-Review Command**: Manual PR review processing via `devintern address-review <pr-url>`
  - Handles single PR review on-demand without running webhook server
  - Uses same worktree isolation and dependency installation as webhook server

### Changed

- **Review Worktree Location**: Moved from `.devintern-code/review-worktree/` to `/tmp/devintern-review-worktree/`
  - Better isolation from main repository
  - Automatic cleanup of stale worktree registrations from old paths

- **Optimized Worktree Operations**: Improved performance for worktree preparation
  - Shallow clone with `--depth 1` for faster initial setup
  - Simplified preparation logic with reduced error noise
  - Single reusable worktree instead of per-PR worktrees

### Fixed

- **Fetch All PR Review Comments**: Now fetches all comments from the PR, not just the latest review
  - Ensures Claude sees complete review context
  - Handles pagination for PRs with many comments

- **Stale Worktree Registration Handling**: Gracefully handles orphaned worktree entries
  - Automatically unregisters worktrees pointing to non-existent directories
  - Prevents "fatal: is already checked out" errors

### Technical

- **Dependencies**: Added `bun:sqlite` for persistent queue (bundled with Bun runtime)
- **Build Process**: Updated `build.ts` to target Bun runtime
- **Documentation**: Updated README.md, USAGE.md, and CLAUDE.md to reflect Bun requirement

## [1.3.1] - 2025-12-23

### Added

- **Automatic Target Branch Detection**: Extract target branch from JIRA task descriptions
  - Add "Target branch: develop" (or "Base branch:" or "PR target:") to task description
  - Supports markdown formatting: `**Target branch**: develop`, `## Target branch: develop`, etc.
  - Falls back to `--pr-target-branch` CLI option when not specified
  - Perfect for server automation where different tasks target different branches

## [1.3.0] - 2025-12-18

### Added

- **GitHub App Authentication**: Organizations can now use GitHub Apps for PR creation instead of individual personal access tokens
  - Each organization creates their own GitHub App for centralized control
  - Fine-grained permissions: only requires Contents (Read) and Pull requests (Read and write)
  - No individual tokens needed - the App authenticates itself
  - Centralized audit trail - all actions show as coming from the App
  - Supports two private key formats:
    - File path: `GITHUB_APP_PRIVATE_KEY_PATH=/path/to/key.pem`
    - Base64-encoded: `GITHUB_APP_PRIVATE_KEY_BASE64=...` (useful for CI/CD)
  - JWT-based authentication with automatic installation token caching
  - Falls back gracefully if App is not installed on a repository
  - **Auto-detected Git author**: Commits are automatically attributed to the GitHub App's bot account (e.g., `my-app[bot]`)

### Changed

- Updated documentation across all markdown files with GitHub App setup instructions
- `GITHUB_TOKEN` takes precedence over GitHub App credentials when both are configured

## [1.2.0] - 2025-11-28

### Added

- **Comment Filtering**: Automatically filter out @devintern/code's own automated comments when fetching task context
  - Prevents context pollution by excluding previous assessment/implementation comments
  - Ensures Claude only sees genuine user and stakeholder feedback
  - Handles all JIRA comment formats: string, rendered HTML, and Atlassian Document Format (ADF)
  - Uses three unique markers to identify automated comments:
    - "Implementation Completed by @devintern/code"
    - "Automated Task Feasibility Assessment"
    - "Implementation Incomplete"
  - Logs number of filtered comments for transparency
  - Comprehensive test coverage with 22 new tests

- **Automatic Git Pull**: Pull latest changes from remote before starting task processing
  - Ensures local repository is up-to-date before creating feature branches
  - Prevents merge conflicts from stale local branches
  - Fetches and pulls from remote origin automatically

- **Automatic JIRA Status Transitions**: Enhanced workflow automation with status transitions
  - **Start Transition**: Automatically move task to "In Progress" when starting implementation (if configured via `inProgressStatus`)
  - **Success Transition**: Automatically move task to review status after PR creation (if configured via `prStatus`)
  - **Failure Transition**: Automatically move task back to "To Do" if implementation fails (if configured via `todoStatus`)
  - Per-project configuration via `settings.json`:
    ```json
    {
      "projects": {
        "PROJ": {
          "inProgressStatus": "In Progress",
          "todoStatus": "To Do",
          "prStatus": "In Review"
        }
      }
    }
    ```
  - Smart status transition detection based on available JIRA workflows

- **Incomplete Implementation Handling**: Better handling when Claude cannot complete a task
  - Posts detailed incomplete implementation comments to JIRA
  - Includes possible reasons for incompletion (clarity, scope, blockers)
  - Provides actionable recommendations for task improvements
  - Duplicate prevention: Skips posting if same task description already has incomplete comment
  - Transitions task back to "To Do" status (if configured)
  - Saves task description for duplicate detection on retry

- **Auto-Commit Recovery**: Automatically commit/amend changes when Claude forgets
  - Detects when Claude makes changes but doesn't commit them
  - Prompts user to auto-commit or amend previous commit
  - Helps recover from interrupted workflows
  - Includes clear git amend instructions in push hook prompts

### Fixed

- **Lock File Cleanup**: Release PID lock file on all exit paths
  - Fixed issue where lock file wasn't cleaned up on early exits (e.g., missing env vars)
  - Lock file now properly released during error conditions, SIGINT, SIGTERM, and uncaught exceptions
  - Prevents stale locks from blocking subsequent runs

- **Status Transition Timing**: Move "In Progress" transition to after clarity assessment
  - Prevents marking tasks as "In Progress" when they fail the clarity check
  - Only transitions to "In Progress" after confirming task is implementable
  - More accurate workflow state management

### Technical

- **Test Coverage Expansion**: Added 22 comprehensive comment filtering tests
  - Tests for all three comment formats (string, HTML, ADF)
  - Edge case handling (null, undefined, empty, malformed bodies)
  - Marker uniqueness verification
  - All 99 tests passing across 5 test suites
- **Improved Error Handling**: Better batch processing resilience with continue-on-error strategy
- **Enhanced Logging**: More detailed git operation logging with verbose mode

## [1.1.1] - 2025-11-25

### Added

- **Instance Lock Mechanism**: Prevent multiple instances from running simultaneously in the same directory
  - Lock file created in `.devintern-code/.pid.lock` when instance starts
  - Automatic detection and cleanup of stale locks from crashed processes
  - Graceful cleanup on process termination (SIGINT, SIGTERM, uncaught exceptions)
  - Added to `.gitignore` to prevent committing lock files
  - Comprehensive test suite with 6 test scenarios using Bun's native test runner
  - Tests run in isolated temporary directories to enable parallel execution

### Technical

- Migrated lock manager tests to use Bun's native `bun:test` API for better integration
- Added test isolation for CLI tests to prevent lock conflicts during parallel test execution
- All 35 tests pass consistently with full parallel execution support

## [1.1.0] - 2025-11-25

### Added

- **Init Command**: New `devintern init` command for easy project setup
  - Creates `.devintern-code/` folder with project-specific configuration
  - Generates `.env` file for JIRA credentials
  - Creates `.env.sample` template with all configuration options
  - Creates `settings.json` for per-project settings
  - **Automatic .gitignore Protection**: Automatically adds `.devintern-code/.env` and `.devintern-code/.env.local` to `.gitignore` to prevent credential leaks

- **Per-Project Settings**: New `settings.json` configuration file for project-specific behavior
  - Configure different PR status transitions for different JIRA projects
  - Example: `{"projects": {"PROJ": {"prStatus": "In Review"}, "ABC": {"prStatus": "Code Review"}}}`
  - Automatically extracts project key from task key (e.g., "PROJ-123" → "PROJ")
  - Per-project configuration takes precedence over global environment variables

- **Enhanced Environment Configuration**: Improved configuration loading with priority order
  1. Custom path (via `--env-file`)
  2. **Project-specific** (`.devintern-code/.env`) - NEW
  3. Current working directory (`.env`)
  4. Home directory (`~/.env`)
  5. Tool installation directory

- **Comprehensive Test Suite**: Added 29 unit tests for reliability
  - Settings management tests (8 tests)
  - CLI argument handling tests (21 tests)
  - All tests organized in `tests/` directory
  - Full TypeScript type coverage including tests

### Changed

- **JIRA PR Status Configuration**: Moved from environment variable to `settings.json`
  - `JIRA_PR_STATUS` environment variable deprecated in favor of per-project configuration
  - Each JIRA project can now have its own status workflow
  - Removed `JIRA_PR_STATUS` from `.env.sample` template

- **CLI Architecture**: Improved command-line argument handling
  - Fixed issue where `init` command conflicted with task key parsing
  - Task keys like "DISCO-123" now work correctly alongside subcommands
  - Early detection of `init` command to avoid Commander.js conflicts

### Dependencies

- Added `@types/bun` for better test type safety

## [1.0.1] - 2025-08-18

### Fixed

- **Git Branching**: Fixed issue where feature branches were always created from main/master instead of respecting the `--pr-target-branch` parameter
  - Feature branches now correctly branch from the specified target branch (e.g., `develop`)
  - Ensures proper git history when creating PRs to non-main branches
  - Updated `createFeatureBranch` function to accept and use the base branch parameter

## [1.0.0] - Initial Release

### Added

- **JIRA Task Processing**: Comprehensive JIRA task fetching with complete context
  - JIRA REST API v3 integration with comprehensive error handling
  - Supports both rendered HTML and Atlassian Document Format content
  - Fetches complete context including subtasks, parent tasks, epics, and linked issues
  - Handles authentication edge cases and API token formats
- **Batch Processing**: Process multiple JIRA tasks sequentially with robust error handling
  - Multiple task keys: Process multiple specific tasks `devintern PROJ-123 PROJ-124 PROJ-125`
  - JQL query support: Full JIRA Query Language support with complex conditions `--jql "project = PROJ AND status = 'To Do'"`
  - Custom field queries: Support for custom fields like `cf[10016] <= 3`
  - Complex filtering: Status, priority, labels, assignee, and date-based filtering
  - Error isolation: Failed tasks don't stop processing of remaining tasks
  - Progress tracking: Real-time progress updates with task indexing ([1/5], [2/5], etc.)
  - Batch summary: Final report showing successful and failed tasks with error details
- **Claude AI Integration**: Automatic implementation using Claude Code
  - Spawns Claude Code as subprocess with enhanced permissions (`-p --dangerously-skip-permissions`)
  - Real-time output streaming to user while capturing for JIRA posting
  - Detects completion status and max-turns errors
  - Posts rich-text implementation summaries back to JIRA using Atlassian Document Format
  - Clarity assessment prompts for feasibility checking
- **Pull Request Creation**: Automatically create PRs on GitHub or Bitbucket after successful implementation
  - Smart repository detection: Automatically detects GitHub/Bitbucket platform and workspace from git remote URL
  - GitHub integration: Full GitHub API integration with personal access token authentication
  - Bitbucket integration: Complete Bitbucket API integration with app password authentication
  - Automatic workspace detection: No need to manually configure Bitbucket workspace
  - Rich PR content: PR descriptions include Claude's implementation details, JIRA task context, and acceptance criteria
  - PR title format: Uses `[TASK-KEY] Task Summary` format for consistency
- **Git Automation**: Seamless git workflow integration
  - Creates feature branches with consistent naming: `feature/{task-key-lowercase}`
  - Handles existing branch scenarios gracefully
  - Automated commit messages include task context
  - Main branch detection: Automatically switches to main/master branch before creating feature branches
  - Integrates with Claude Code workflow for seamless development
- **Dynamic File Management**: Smart output file handling for batch processing
  - Dynamic naming prevents file conflicts with pattern `{base-name}-{task-key-lowercase}.md`
  - Separate files for each task enable parallel review
  - Configurable output directory via `DEVINTERN_OUTPUT_DIR` environment variable
- **Comprehensive CLI Interface**: Full-featured command-line interface
  - `--jql` for JQL query-based batch processing
  - `--create-pr` to automatically create pull requests
  - `--pr-target-branch` to specify target branch (default: main)
  - `--no-agent` to skip Claude execution (formatting only)
  - `--no-git` to skip branch creation
  - `--skip-clarity-check` to bypass feasibility analysis
  - `--no-auto-commit` to skip automatic commits
  - `--claude-path` and `--max-turns` for Claude configuration
  - `-v` for verbose logging
  - `--env-file` for custom environment file path
- **JIRA Status Automation**: Automatic task status transition after successful PR creation
- **Rich Text Processing**: Advanced content format conversion
  - Converts JIRA's Atlassian Document Format to readable text
  - Smart link detection for external resources
  - HTML to Markdown conversion for Claude consumption
  - Creates structured prompts with task context, related issues, and linked resources
- **Comprehensive Environment Configuration**:
  - Multi-location `.env` file loading (current directory, home directory, installation directory)
  - Custom environment file path with `--env-file`
  - Required: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`
  - Optional: `GITHUB_TOKEN` or GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`), `BITBUCKET_TOKEN`, `DEVINTERN_OUTPUT_DIR`

### Technical Architecture

- **Modular TypeScript Architecture**: Optimized for Bun runtime during development and Node.js for distribution
- **Core Components**:
  - Main entry point (`src/index.ts`) with Bun shebang and CLI orchestration
  - JIRA Client (`src/lib/jira-client.ts`) with comprehensive API integration
  - Task Formatter (`src/lib/task-formatter.ts`) for Atlassian Document Format conversion
  - Utilities (`src/lib/utils.ts`) for git operations and file handling
  - Comprehensive type definitions (`src/types/`) for all data structures
- **Runtime Strategy**: Bun for fast development, Node.js-compatible bundled output for npm distribution
- **Modular PR Client Architecture**: Abstract base class with platform-specific implementations
- **Repository Platform Detection**: Intelligent parsing of git remote URLs for GitHub and Bitbucket
- **Token Authentication**: Secure API authentication with proper error handling
- **Type Safety**: Full TypeScript support for all functionality including batch processing
- **Error Handling and Validation**:
  - Comprehensive environment validation
  - JIRA API authentication testing
  - Claude CLI path resolution across platforms
  - Graceful degradation when optional features fail

### Workflow

Complete workflow orchestration: fetch → format → git → claude → commit → jira

1. **Fetch**: Retrieve JIRA task details including description, comments, linked resources, and related work items
2. **Format**: Convert JIRA data into Claude-readable markdown format with comprehensive context
3. **Branch**: Create feature branch named `feature/{task-key}`
4. **Assess**: Run optional clarity check to validate task implementability
5. **Implement**: Execute Claude Code with formatted task details and enhanced permissions
6. **Commit**: Automatically commit changes with descriptive message
7. **Push**: Push feature branch to remote repository (when creating PRs)
8. **PR Creation**: Optionally create pull requests on GitHub or Bitbucket
9. **Status Transition**: Automatically transition JIRA task status after successful PR creation (if configured)
10. **Report**: Post implementation summary back to JIRA task

### Installation & Usage

- **Global Installation**: `bun install -g @devintern/code` or `bunx @devintern/code`
- **Single Task**: `devintern PROJ-123`
- **Multiple Tasks**: `devintern PROJ-123 PROJ-124 PROJ-125`
- **JQL Queries**: `devintern --jql "project = PROJ AND status = 'To Do'"`
- **With PR Creation**: `devintern PROJ-123 --create-pr`
