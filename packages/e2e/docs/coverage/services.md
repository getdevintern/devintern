# Auth, licensing, and observability e2e coverage

Scope: Supabase `login`/`logout`/`whoami`, the automation license gate, Sentry error monitors, anonymous telemetry and update checks, and worker notification delivery (Slack, generic webhook).

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Supabase login/logout/whoami and session refresh

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `partial`
- Evidence: `tests/local/services-license-gate.test.ts` (`bun run --filter @devintern/e2e test`). Offline only: with Supabase refused by a recording proxy, an expired (refresh-retry) or unexpired (`getUser`) fake session resolves to signed out, prints no token, and the CLI exits normally; `logout` still removes the local session file.
- Missing: Any real sign-in, a successful refresh, and signed-in entitlement paths are `blocked`: the Supabase URL is hardcoded (`DEFAULT_SUPABASE_URL`, `packages/auth/src/index.ts`), so they need a product-side auth URL override or a live account suite. Finding: with Supabase unreachable, supabase-js logs each failed fetch with `console.error(e)` (`@supabase/auth-js/dist/main/lib/fetch.js`), so stderr shows raw `ERR_PROXY_TUNNEL` error dumps with bundle source snippets (no tokens); and an expired session waits about 25 s on refresh retries before giving up (the suite collapses those backoff sleeps with `helpers/fast-auth-backoff-preload.cjs`; every attempt still runs).
- Last reviewed: 2026-11-18

### Automation license gate, Worker Pilot trial, offline/expired behavior

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `partial`
- Evidence: `tests/local/services-license-gate.test.ts` (`bun run --filter @devintern/e2e test`). With `DEVINTERN_SKIP_LICENSE_CHECK` removed and all egress refused: an automated (`CI=1`) task run with no key and no session exits `77` (`AUTOMATION_ACCESS_EXIT_CODE`) with `LICENSE_KEY` guidance (and the Worker Pilot `devintern login` hint under `DEVINTERN_WORKER_TRIAL=1`) and no egress; a fake `LICENSE_KEY` with Polar unreachable fails closed (only `api.polar.sh` contacted, key never printed); an unrefreshable session with Supabase unreachable is denied as signed out; `devintern worker` exits `1` before draining a queued task. In every denial the agent never runs and no branch reaches the local bare remote. Without `CI`, a Bun preload (`helpers/fake-cgroup-preload.cjs`) pins the CLI's `/proc/self/cgroup` so both boundaries run on every Linux host: a terminal `.scope` skips the license check and pushes the head branch, while a systemd `.service` still counts as automated and exits `77`.
- Missing: Cached-entitlement grace, an active or expired Worker Pilot, a valid paid key, and `worker init`'s license step are `blocked`: they need a signed-in session (hardcoded Supabase URL, so a product-side auth URL override or a live account) or a real Polar key (`POLAR_API_BASE` is hardcoded).
- Last reviewed: 2026-11-18

### Sentry error-monitor polling and auto-fix

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `default`
- Evidence: `tests/local/worker-sentry-monitor.test.ts` (single-issue happy path, success comment, dedupe) and `tests/local/worker-sentry-selection.test.ts` (`bun run --filter @devintern/e2e test`). With five fake unresolved issues, `min_occurrences = 5`, `max_per_tick = 2`, and `query = "environment:production"`: the below-threshold issue is never actioned, an issue at exactly the threshold is, the first poll starts two runs and the third eligible issue waits for a later poll, an issue whose count is raised past the threshold mid-test gets one run on a later poll, and every eligible issue gets exactly one run and one success comment across repeated polls. Every issue-list request carries `is:unresolved environment:production`; the threshold is applied client-side, not in the query.
- Missing: Live Sentry project; issue status resolution after deployment.
- Last reviewed: 2026-11-19

### Anonymous telemetry opt-out and update check

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `default`
- Evidence: `tests/local/cli-privacy-egress.test.ts` (`bun run --filter @devintern/e2e test`). Through a refusing recording proxy, `devintern doctor` makes zero requests with `DEVINTERN_TELEMETRY_DISABLED=1` or `analytics.enabled: false` (after a one-time `analytics_opt_out`), while enabled telemetry reaches the baked PostHog host; the update check contacts `registry.npmjs.org` from a Bun global install and is silenced by `DEVINTERN_NO_UPDATE=1` and `--no-update`.
- Missing: Only `devintern doctor` is probed (not task runs or the worker); events are never actually delivered, since the proxy refuses every tunnel.
- Last reviewed: 2026-11-18

### `login`, `logout`, `whoami`

- Surface: `devintern` command surface
- Status: `partial`
- Evidence: `tests/local/services-license-gate.test.ts` (`bun run --filter @devintern/e2e test`). With no session, `whoami` prints "Not signed in. Run `devintern login`." and `logout` prints `✅ Signed out`, both exit `0` with no egress; with an unverifiable session and Supabase unreachable, `whoami` reports signed out without tokens and `logout` removes the session file.
- Missing: `login` stays `gap`: it is browser-interactive (OAuth or an email magic link through a local callback server) and needs a live account or a product-side Supabase URL override. Signed-in `whoami` output is blocked on the same prerequisite.
- Last reviewed: 2026-11-18

### Sentry error monitors

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-sentry-monitor.test.ts` and `tests/local/worker-sentry-selection.test.ts`: `min_occurrences`, `max_per_tick`, and `query` from `[[error_monitors]]` all reach the poll (see the polling row above).
- Missing: Live Sentry project.
- Last reviewed: 2026-11-19

### Sentry: failed remediation comment and comment_on_action = false

- Surface: `devintern worker` surface
- Status: `default`
- Evidence: `tests/local/worker-sentry-selection.test.ts`. A run that fails (the fake agent exits `18` before editing) is recorded `failed` and posts exactly the `SENTRY_ACTION_FAILED_COMMENT` text, never the success text; the issue stays claimed, so later polls neither retry nor comment again. With `comment_on_action = false`, a successful run is still recorded and no comment request reaches the fake. `tests/local/worker-sentry-comment-rejected.test.ts` (`bun run --filter @devintern/e2e test`): when the fake rejects the comment with 403 or 401 after a successful fix, or with 503, the worker stays up, the run stays recorded `succeeded`, the worker logs one `could not comment on <id>` warning (with the "Issue & Event write access" hint for 401/403), and later polls start no second run. Comment attempts stay bounded (at most 3 per issue) and at most one comment is posted after Sentry recovers. The token is absent from the worker log, run records, raw state database, and dashboard `/api/runs`, `/api/runs/:id` (plus harness logs and artifacts), `/api/logs`, `/api/sources`, and `/api/workspace`.
- Missing: Only a live project would prove the real comment endpoint accepts the body and returns these statuses. Observed (unconfirmed intent): a 5xx comment is sent once and never retried, unlike issue-list reads, which retry 5xx twice. After Sentry recovers, the dropped comment is never re-sent, because the issue stays claimed. The test asserts only the bound and "at most one comment", not that the comment is lost.
- Last reviewed: 2026-11-20

### Notification delivery: Slack and signed webhook channels from the worker

- Surface: External dependency: notifications (Slack incoming webhooks, generic JSON webhook)
- Status: `default`
- Evidence: `tests/local/worker-notification-delivery.test.ts` (`bun run --filter @devintern/e2e test`). A real worker with `[notifications.slack]` and `[notifications.webhook]` (`url_env`, `secret_env`) reads both endpoint URLs and the signing secret only from the workspace `.env` and posts to a loopback receiver. A failed ad-hoc task (fake agent exits non-zero) raises one high-severity `retries_exhausted` notification. The webhook gets exactly one JSON `POST` with the documented payload (`source: "devintern"`, `version: 1`, `type: "notification"`, `event: "created"`, the notification's `kind`, `severity`, `repo`, `title`, `groupKey`, and `dashboardUrl` = `<dashboard_url>/#/runs/<id>`) and `X-DevIntern-Signature: sha256=<HMAC-SHA256 of the raw body>`. Slack gets one JSON `POST` with the title, repo, and an "Open in dashboard" link under `dashboard_url`. A later tick does not resend. Re-running the same task (`worker add --resume`) folds into the same group (count 2), and within the default 60-minute `rate_limit_minutes` nothing more is sent on either channel. A new group still reaches Slack while the webhook answers HTTP 500: the webhook is tried 3 times (one try plus two retries) and given up, the Slack send is not delayed by those retries, the worker logs `webhook delivery of notification #<id> failed: webhook answered HTTP 500`, and the run outcome is unchanged. Neither body nor the worker log contains the dummy Slack token path, the signing secret, their URL-encoded forms, or the receiver URL.
- Missing: The desktop channel (`notify-send`/`osascript` on a real notification daemon), `digest_time` digests, `notify_resolved` resolve messages, `min_severity = "normal"` and `kinds`/`exclude_kinds` filters, the release of a held repeat once the rate-limit window ends, an inline webhook `url`, and `devintern worker doctor --test-notifications` (`event: "test"`; the next gap for this area). Only `retries_exhausted` is driven end to end; `escalated` and `internal_error` are unit-tested only. No real Slack workspace is contacted, so Slack's acceptance of the body and its HTTP semantics are not proven.
- Last reviewed: 2026-11-27

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- ~~Priority 15: Sentry auto-fix with a fake or opt-in project.~~
- Priority 16: Auth/license (`login`, `logout`, `whoami`, trial, expired/offline) with a safe fake or explicit account suite. Offline signed-out and fail-closed paths are covered; `login`, trial, grace, and signed-in paths remain (need a Supabase URL override or an account suite).

## Test notes

### `tests/local/services-license-gate.test.ts`

- Proves: the automation license gate fails closed offline for task runs (exit `77`) and `devintern worker` (exit `1`) with the exact `checkLicense` guidance, no agent invocation, and no branch on the local bare remote; and the signed-out `whoami`/`logout` behavior with no session and with an unverifiable session while Supabase is unreachable (`logout` still removes the session file).
- How: unsets `DEVINTERN_SKIP_LICENSE_CHECK` for these children only and routes HTTP(S) through `helpers/recording-proxy.ts`, which refuses every tunnel and records target hosts. Assertions allow only `api.polar.sh` (fake `LICENSE_KEY`) or the hardcoded Supabase host (fake session). Credentials are obviously fake strings, and the tests assert none appears in stdout or stderr. Session files are written to `<project>/.devintern-code/.auth-session.json`.
- Run: `bun run --filter @devintern/e2e test`, or `bun test tests/local/services-license-gate.test.ts` from `packages/e2e`.
- Prerequisites: the built CLI (`bun run --filter @getdevintern/code build`); otherwise the file skips. No network or account. The two expired-session cases preload `helpers/fast-auth-backoff-preload.cjs`, which skips the sleeps between supabase-js refresh retries (about 25 s otherwise) while every attempt still reaches the refusing proxy.

### `tests/local/worker-sentry-selection.test.ts`

- Proves: Sentry issue selection across several unresolved issues (`min_occurrences` threshold including the boundary, the `max_per_tick` budget per poll with the remainder taken by later polls, an issue crossing the threshold between polls, exactly one run and one comment per eligible issue, and the configured `query` on every list request); the failed-run comment text; and that `comment_on_action = false` posts nothing while still recording the run.
- How: `WorkerFixture` with `[[error_monitors]]` pointing at `providers/fake-sentry.ts` (now able to seed several issues, change an issue's count, and timestamp each list request). Runs per poll are derived from run records: each run is attributed to the latest list read before its `started_at`, which is exact because a poll is single-flight and runs its picks one after another. The failure uses the fake agent's `E2E_FAIL_ONCE_FILE`. The Sentry token is a random fake string and is never printed.
- Run: `bun run --filter @devintern/e2e test`, or `bun test tests/local/worker-sentry-selection.test.ts` from `packages/e2e`.
- Prerequisites: the built CLI (`bun run --filter @getdevintern/code build`); otherwise the file skips. No network or account. About 10 s for all three tests.

### `tests/local/worker-sentry-comment-rejected.test.ts`

- Proves: a Sentry comment rejected after remediation (403 and 401 on two issues in one poll; 503 on a single issue, which then recovers) does not crash the worker or change the run outcome. The issue stays claimed, so no duplicate run starts. Comment attempts stay bounded with at most one comment after recovery, a warning is logged, and the Sentry token never appears in the worker log, run records, state database, or dashboard API responses.
- How: `WorkerFixture` with the embedded dashboard on a free loopback port and `[[error_monitors]]` pointing at `providers/fake-sentry.ts`. The fake now rejects comment writes with a chosen status (`rejectCommentsWith`, per-issue `commentRejections`, or `setCommentRejection` mid-test) and records each attempt's status. The token is a random fake string; diagnostics redact it, and leak checks assert booleans so a failure cannot print it.
- Run: `bun run --filter @devintern/e2e test`, or `bun test tests/local/worker-sentry-comment-rejected.test.ts` from `packages/e2e`.
- Prerequisites: the built CLI (`bun run --filter @getdevintern/code build`); otherwise the file skips. No network or account. About 10 s for both tests.

### `tests/local/worker-notification-delivery.test.ts`

- Proves: worker notification delivery from a failed run to Slack and a signed generic webhook (payload shape, HMAC signature, dashboard links), no resend on later ticks, the per-group rate limit holding a repeat, a failing webhook (HTTP 500, bounded retries) not blocking Slack or changing the run outcome, and no credential in request bodies or the worker log.
- How: `WorkerFixture` with `[notifications]` tables in `workspaceTomlExtra`, endpoint URLs and a generated dummy signing secret in the workspace `.env`, and `helpers/notification-receiver.ts`, a loopback server that records method, path, headers, and raw body and can answer a chosen status per path. The fake agent fails prompts carrying `E2E_FAIL_PROMPT_MARKER`. Delivery ticks every 30 s and a channel only delivers notifications newer than its first tick, so the test enqueues the failing task after the first tick and waits for ticks through the queue DB (`notification_delivery_ticks`) instead of fixed sleeps. Secret comparisons assert booleans, and diagnostics redact the token and secret.
- Run: `bun run --filter @devintern/e2e test`, or `bun test tests/local/worker-notification-delivery.test.ts` from `packages/e2e`.
- Prerequisites: the built CLI (`bun run --filter @getdevintern/code build`); otherwise the file skips. No network or account. About 2.5 minutes, mostly waiting on the 30 s delivery interval.
