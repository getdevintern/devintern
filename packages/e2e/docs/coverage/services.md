# Auth, licensing, and observability e2e coverage

Scope: Supabase `login`/`logout`/`whoami`, the automation license gate, Sentry error monitors, and anonymous telemetry and update checks.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Supabase login/logout/whoami and session refresh

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `partial`
- Evidence: `tests/local/services-license-gate.test.ts` (`bun run --filter @devintern/e2e test`). Offline only: with Supabase refused by a recording proxy, an expired (refresh-retry) or unexpired (`getUser`) fake session resolves to signed out, prints no token, and the CLI exits normally; `logout` still removes the local session file.
- Missing: Any real sign-in, a successful refresh, and signed-in entitlement paths are `blocked`: the Supabase URL is hardcoded (`DEFAULT_SUPABASE_URL`, `packages/auth/src/index.ts`), so they need a product-side auth URL override or a live account suite. Finding: with Supabase unreachable, supabase-js logs each failed fetch with `console.error(e)` (`@supabase/auth-js/dist/main/lib/fetch.js`), so stderr shows raw `ERR_PROXY_TUNNEL` error dumps with bundle source snippets (no tokens); and an expired session waits about 25 s on refresh retries before giving up.
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
- Evidence: `tests/local/worker-sentry-monitor.test.ts`
- Missing: Live Sentry project; issue status resolution after deployment; multiple concurrent issues.
- Last reviewed: 2026-11-17

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
- Evidence: `tests/local/worker-sentry-monitor.test.ts`
- Missing: Live Sentry project and multiple concurrent issues.
- Last reviewed: 2026-11-17

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 15: Sentry auto-fix with a fake or opt-in project.
- Priority 16: Auth/license (`login`, `logout`, `whoami`, trial, expired/offline) with a safe fake or explicit account suite. Offline signed-out and fail-closed paths are covered; `login`, trial, grace, and signed-in paths remain (need a Supabase URL override or an account suite).

## Test notes

### `tests/local/services-license-gate.test.ts`

- Proves: the automation license gate fails closed offline for task runs (exit `77`) and `devintern worker` (exit `1`) with the exact `checkLicense` guidance, no agent invocation, and no branch on the local bare remote; and the signed-out `whoami`/`logout` behavior with no session and with an unverifiable session while Supabase is unreachable (`logout` still removes the session file).
- How: unsets `DEVINTERN_SKIP_LICENSE_CHECK` for these children only and routes HTTP(S) through `helpers/recording-proxy.ts`, which refuses every tunnel and records target hosts. Assertions allow only `api.polar.sh` (fake `LICENSE_KEY`) or the hardcoded Supabase host (fake session). Credentials are obviously fake strings, and the tests assert none appears in stdout or stderr. Session files are written to `<project>/.devintern-code/.auth-session.json`.
- Run: `bun run --filter @devintern/e2e test`, or `bun test tests/local/services-license-gate.test.ts` from `packages/e2e`.
- Prerequisites: the built CLI (`bun run --filter @getdevintern/code build`); otherwise the file skips. No network or account. The two expired-session cases take about 25 s each because supabase-js retries the refresh.
