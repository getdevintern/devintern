# Direct webhook e2e coverage

Scope: `devintern webhook serve`, signature validation, and duplicate delivery handling.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Direct webhook server (`webhook serve`) and signature validation

- Surface: External dependency: relay, auth, licensing, and observability services
- Status: `default`
- Evidence: `tests/local/webhook-serve.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Live provider callbacks and event-specific pipelines; loopback HTTP only.
- Last reviewed: 2026-11-17

### `webhook serve`

- Surface: `devintern` command surface
- Status: `default`
- Evidence: `tests/local/webhook-serve.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: Live provider callbacks and event-specific pipelines.
- Last reviewed: 2026-11-17

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 11: `webhook serve` with signed GitHub/GitLab payloads.

## Test notes

### Direct webhook serve

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
