# Auth, licensing, and observability e2e coverage

Scope: Supabase `login`/`logout`/`whoami`, the automation license gate, Sentry error monitors, and anonymous telemetry and update checks.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Supabase login/logout/whoami and session refresh

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `gap`
- Evidence: —
- Missing: Safe local fake or explicit opt-in account suite.
- Last reviewed: 2026-11-17

### Automation license gate, Worker Pilot trial, offline/expired behavior

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `gap`
- Evidence: —
- Missing: Tests currently disable the gate.
- Last reviewed: 2026-11-17

### Sentry error-monitor polling and auto-fix

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `default`
- Evidence: `tests/local/worker-sentry-monitor.test.ts`
- Missing: Live Sentry project; issue status resolution after deployment; multiple concurrent issues.
- Last reviewed: 2026-11-17

### Anonymous telemetry opt-out and update check

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `gap`
- Evidence: —
- Missing: Tests disable both; assert no network when disabled.
- Last reviewed: 2026-11-17

### `login`, `logout`, `whoami`

- Surface: `devintern` command surface
- Status: `gap`
- Evidence: —
- Missing: Local fake session or opt-in account suite.
- Last reviewed: 2026-11-17

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
- Priority 16: Auth/license (`login`, `logout`, `whoami`, trial, expired/offline) with a safe fake or explicit account suite.
