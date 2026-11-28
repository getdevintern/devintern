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
- Missing: The desktop channel (`notify-send`/`osascript` on a real notification daemon), `digest_time` digests, the release of a held repeat once the rate-limit window ends, and an inline webhook `url`. Filters, resolve messages, and `worker doctor --test-notifications` have their own rows below. Only `retries_exhausted` and `work_spawned` are driven end to end; `escalated` and `internal_error` are unit-tested only. No real Slack workspace is contacted, so Slack's acceptance of the body and its HTTP semantics are not proven.
- Last reviewed: 2026-11-28

### Notification test messages: `devintern worker doctor --test-notifications`

- Surface: External dependency: notifications (Slack incoming webhooks, generic JSON webhook)
- Status: `default`
- Evidence: `tests/local/worker-notification-doctor.test.ts` (`bun run --filter @devintern/e2e test`). With `[notifications.slack]` and a signed `[notifications.webhook]` reading their endpoints and secret only from the workspace `.env`: plain `worker doctor` lists both channels (`✅ Notification delivery — slack, webhook; links open <dashboard_url> (send a test with --test-notifications)`) and sends nothing. `--test-notifications` sends exactly one message per channel and exits `0` with `test message sent` under each channel line. The webhook body has `event: "test"`, `source: "devintern"`, `version: 1`, `type: "notification"` and `dashboardUrl` = `<dashboard_url>/#/inbox`, with `X-DevIntern-Signature: sha256=<HMAC-SHA256 of the raw body>` from the `secret_env` secret; Slack gets one unsigned JSON `POST` with an "Open in dashboard" link to `<dashboard_url>/#/inbox`. With the webhook answering HTTP 500, doctor exits `1` with `❌ Notification delivery — slack, webhook: 1 test message(s) failed`, `test failed: webhook answered HTTP 500` under the webhook line, the endpoint hint, and `Setup: not_ready — 1 check failed (Notification delivery).`; the webhook is tried 3 times (each signed) while Slack still gets its message. A refusing recording proxy sees no request, doctor creates no state database, and no output or body contains the dummy token, secret, or receiver URL.
- Missing: The desktop channel's test message, `--offline` skipping network channels, and a real Slack workspace.
- Last reviewed: 2026-11-28

### Notification filters: `kinds`, `exclude_kinds`, `min_severity`

- Surface: External dependency: notifications (Slack incoming webhooks, generic JSON webhook)
- Status: `partial`
- Evidence: `tests/local/worker-notification-filters.test.ts` (`bun run --filter @devintern/e2e test`). A real worker raises a high-severity `retries_exhausted` (failed ad-hoc task) and a normal-severity `work_spawned` (the fake agent delegates a follow-up with `worker add`, linked through `DEVINTERN_RUN_ID`). Slack sets `exclude_kinds = ["retries_exhausted"]` and keeps the default `min_severity = "high"`; the webhook sets `min_severity = "normal"` and no kind filter. The webhook receives both (one signed `event: "created"` message each, with the right `kind`, `severity`, and run link); Slack receives neither, and both of its delivery records are `skipped` (the first by kind, the second by severity). A later tick sends nothing more. An unknown kind in `kinds` or `exclude_kinds` fails `worker doctor` (exit `1`) with `❌ Workspace config — [notifications.<channel>].<key> has unknown kind "<name>"; known kinds: …` per entry.
- Missing: An include-list `kinds` filter is only checked for config validation, not for delivery; combining `kinds` with `exclude_kinds` on one channel; `pr_opened` and `pr_auto_merged` (normal severity) need a forge, so only `work_spawned` proves the severity half.
- Last reviewed: 2026-11-28

### Notification resolve messages: `notify_resolved`

- Surface: External dependency: notifications (Slack incoming webhooks, generic JSON webhook)
- Status: `default`
- Evidence: `tests/local/worker-notification-resolved.test.ts` (`bun run --filter @devintern/e2e test`). With `notify_resolved = true` on the webhook only, a one-shot failure (`E2E_FAIL_ONCE_FILE`) raises `retries_exhausted`, delivered as `event: "created"` to both channels. `worker add --resume` of the same task then succeeds, the run rules resolve the row, and the webhook gets exactly one signed `event: "resolved"` message for that notification (same `id`, `groupKey`, `title`, run link, and `resolvedAt` equal to the stored `resolved_at`). Slack gets no resolve message; the delivery records show `resolved_sent` 1 for the webhook and 0 for Slack; a later tick does not resend.
- Missing: Slack's `Resolved: <title>` rendering (not driven), a resolve send that fails and is retried on a later tick, and a resolve of a notification the channel never delivered.
- Last reviewed: 2026-11-28

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
- How: `WorkerFixture` with `[notifications]` tables in `workspaceTomlExtra`, endpoint URLs and a generated dummy signing secret in the workspace `.env` (shared setup in `helpers/notification-delivery.ts`), and `helpers/notification-receiver.ts`, a loopback server that records method, path, headers, and raw body and can answer a chosen status per path. The fake agent fails prompts carrying `E2E_FAIL_PROMPT_MARKER`. Delivery ticks every 30 s and a channel only delivers notifications newer than its first tick, so the test enqueues the failing task after the first tick and waits for ticks through the queue DB (`notification_delivery_ticks`) instead of fixed sleeps. Secret comparisons assert booleans, and diagnostics redact the token and secret.
- Run: `bun run --filter @devintern/e2e test`, or `bun test tests/local/worker-notification-delivery.test.ts` from `packages/e2e`.
- Prerequisites: the built CLI (`bun run --filter @getdevintern/code build`); otherwise the file skips. No network or account. About 2.5 minutes, mostly waiting on the 30 s delivery interval.

### `tests/local/worker-notification-doctor.test.ts`

- Proves: `worker doctor --test-notifications` sends exactly one test message per configured channel (signed webhook with `event: "test"` and the documented envelope; Slack with an inbox link), plain `worker doctor` sends nothing, and a webhook answering HTTP 500 fails the notification row (exit `1`, the product's failure line and hint) after 3 attempts while Slack still gets its message.
- How: `WorkerFixture` (prepared, never started) with the `[notifications]` block from `helpers/notification-delivery.ts`, endpoint URLs and a generated dummy secret in the workspace `.env`, `helpers/notification-receiver.ts` as the loopback endpoint, and `helpers/recording-proxy.ts` refusing all egress. Leak checks assert booleans.
- Run: `bun run --filter @devintern/e2e test`, or `bun test tests/local/worker-notification-doctor.test.ts` from `packages/e2e`.
- Prerequisites: the built CLI (`bun run --filter @getdevintern/code build`); otherwise the file skips. No network or account. About 5 s.

### `tests/local/worker-notification-filters.test.ts`

- Proves: per-channel `exclude_kinds` and `min_severity` decide delivery (the unfiltered `min_severity = "normal"` webhook gets a high `retries_exhausted` and a normal `work_spawned`; Slack, excluding `retries_exhausted` at the default `high`, gets neither), and an unknown kind name is rejected at config load.
- How: `WorkerFixture` with the shared notification setup and a refusing recording proxy. `work_spawned` comes from the fake agent's `E2EDELEGATEFOLLOWUP` marker (added to `helpers/fake-agent.ts`), which runs the built CLI's `worker add` from inside the run, so the queue links the follow-up to the delegating run. Ticks are read from the queue DB (`notification_delivery_ticks`), and the test waits for all four `notification_deliveries` records before checking counts. The config check runs `worker doctor` on a workspace with misspelled kinds.
- Run: `bun run --filter @devintern/e2e test`, or `bun test tests/local/worker-notification-filters.test.ts` from `packages/e2e`.
- Prerequisites: the built CLI (`bun run --filter @getdevintern/code build`); otherwise the file skips. No network or account. About 90 s, mostly waiting on the 30 s delivery interval.

### `tests/local/worker-notification-resolved.test.ts`

- Proves: with `notify_resolved = true` on the webhook, a notification resolved by a later successful run of the same task sends exactly one signed `event: "resolved"` message there, none to Slack (no `notify_resolved`), and no resend on later ticks.
- How: `WorkerFixture` with the shared notification setup and a refusing recording proxy. The fake agent's `E2E_FAIL_ONCE_FILE` sentinel is planted after the warm-up so only the task under test fails, once; `worker add --resume` then succeeds (as `tests/local/dashboard-inbox.test.ts` does for auto-resolve). Delivery state (`resolved_sent`) is read from the queue DB.
- Run: `bun run --filter @devintern/e2e test`, or `bun test tests/local/worker-notification-resolved.test.ts` from `packages/e2e`.
- Prerequisites: the built CLI (`bun run --filter @getdevintern/code build`); otherwise the file skips. No network or account. About 2 minutes, mostly waiting on the 30 s delivery interval.
