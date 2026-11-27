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

### webhook serve: signed GitLab MR note on a registered agent MR runs address-review

- Surface: External dependency: GitLab webhook payloads and MR discussions/notes REST API
- Status: `default`
- Evidence: `tests/local/webhook-gitlab-review.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: A real GitLab instance (payload and API drift are pinned only by the loopback fake); positioned diff notes, multi-discussion and fork MRs; failed or usage-limited review runs.
- Last reviewed: 2026-11-24

### webhook serve: GitLab MR merge/close lifecycle and unregistered-MR deliveries

- Surface: External dependency: GitLab webhook payloads
- Status: `default`
- Evidence: `tests/local/webhook-gitlab-review.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: `worker prs` output for webhook-closed rows (the test reads the state database).
- Last reviewed: 2026-11-24

### webhook serve: signed GitLab Pipeline/Job failure on a registered agent MR runs CI repair

- Surface: External dependency: GitLab Pipeline Hook and Job Hook payloads; MR, pipelines, pipeline jobs, commit statuses and job trace REST API
- Status: `default`
- Evidence: `tests/local/webhook-gitlab-ci-sync.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: A real GitLab instance; failing external commit statuses (served empty) and `allow_failure` jobs; several failed jobs or paginated job lists; a failed or usage-limited repair run. Stale-SHA Job and Pipeline Hooks are in the stale-head row below.
- Last reviewed: 2026-11-27

### webhook serve: signed GitLab MR conflict delivery runs conflict resolution

- Surface: External dependency: GitLab Merge Request Hook `detailed_merge_status` payloads and MR mergeability REST API
- Status: `default`
- Evidence: `tests/local/webhook-gitlab-ci-sync.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: A real GitLab instance; a conflict the agent cannot resolve. Legacy `merge_status` and a stale `last_commit` SHA are in the rows below.
- Last reviewed: 2026-11-27

### webhook serve: GitLab `X-Gitlab-Token` shared-secret mode on the review path

- Surface: External dependency: GitLab webhook secret-token header
- Status: `default`
- Evidence: `tests/local/webhook-gitlab-ci-sync.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: A real GitLab instance. Both secrets configured at once is the next row.
- Last reviewed: 2026-11-27

### webhook serve: both `GITLAB_WEBHOOK_SECRET` and `GITLAB_WEBHOOK_SIGNING_TOKEN` configured, no downgrade from a forged signature

- Surface: External dependency: GitLab webhooks (Self-Managed and GitLab.com)
- Status: `default`
- Evidence: `tests/local/webhook-gitlab-delivery-drift.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: A real GitLab instance; a stale or malformed `webhook-timestamp` together with a valid `X-Gitlab-Token` (only a wrong HMAC is sent).
- Last reviewed: 2026-11-27

### webhook serve: legacy `merge_status: cannot_be_merged` (no `detailed_merge_status`) runs conflict resolution

- Surface: External dependency: GitLab webhooks (Self-Managed and GitLab.com)
- Status: `default`
- Evidence: `tests/local/webhook-gitlab-delivery-drift.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: A real older GitLab Self-Managed instance (the payload shape is pinned only by the test's builder); legacy `merge_status` values other than `cannot_be_merged` / `can_be_merged` (for example `unchecked`).
- Last reviewed: 2026-11-27

### webhook serve: conflict and Job/Pipeline deliveries for a stale head SHA run nothing

- Surface: External dependency: GitLab webhooks (Self-Managed and GitLab.com)
- Status: `default`
- Evidence: `tests/local/webhook-gitlab-delivery-drift.test.ts` (`bun run --filter @devintern/e2e test`)
- Missing: A real GitLab instance; a stale delivery for an MR that is no longer `opened` on the forge (the other branch of the same guard); a stale `need_rebase` delivery.
- Last reviewed: 2026-11-27

## Backlog

Priority numbers are the global ranking from the
[index](../coverage-matrix.md#priority-backlog); lower runs first.

- Priority 11: `webhook serve` with signed GitHub/GitLab payloads. The GitLab half
  is covered: note → address-review (signature and `X-Gitlab-Token` modes),
  merge/close lifecycle, unregistered MR, failed Pipeline/Job Hook → CI repair,
  and `conflict`/`need_rebase` Merge Request Hook → conflict resolution. The
  GitHub review pipeline is still open: it cannot be faked offline because
  `packages/code/src/lib/code-host/github/reviews.ts` hardcodes
  `https://api.github.com`.

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

### GitLab MR deliveries through the review pipeline

`tests/local/webhook-gitlab-review.test.ts` proves that a signed GitLab
delivery for a registered agent MR really drives the pipeline, which
`webhook-serve.test.ts` deliberately keeps paused. It runs in the default
offline suite:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

Each test seeds a local bare repository (base branch plus agent branches),
starts the loopback `FakeGitlabForge` with one unresolved reviewer discussion,
and starts `devintern webhook serve` through `WebhookServerFixture` without
the rate-limit seed, with `GITLAB_CODE_HOST_URL` pointing at the fake and the
seeded checkout as its working directory. The checkout's origin is the fake's
HTTP URL; a `git` wrapper and `url.<bare>.insteadOf` send fetch and push to the
bare repository. Registered MRs are `agent_prs` rows written into the isolated
state database. Deliveries carry Standard Webhooks headers signed with a random
`whsec_` token.

- Note on a registered MR: the response reports `matchedMergeRequests: 1`;
  `address-review` fetches the discussion, the deterministic agent receives a
  prompt with the discussion's unique marker (the delivery's own note text has
  none), a new commit lands on the MR branch, and the run replies to the
  discussion and makes no other forge write. A replay of the settled delivery
  returns `Duplicate delivery` with no second agent run.
- Merge and close hooks mark their rows closed with `close_reason` `merged` and
  `closed` (merge target and GitLab merge time recorded for the merge) and make no
  agent run and no forge request; a later note for the merged MR no longer matches.
- A valid note for an unregistered MR iid, both before and after rows exist,
  returns `No registered GitLab MR matched` and makes no agent run and no forge
  request.

Isolation: HOME, workspace, queue/state database, review worktree, bare remote
and fake agent live under one temporary root, removed after each test along
with the server and fake forge. The GitLab token and signing secret are random
per run, and the test asserts that neither (raw or URL-encoded) appears in the
server output. The fake forge records method and path only, rejects any other
token, and records requests it does not serve as unexpected. Waits poll the
delivery dedupe row, never a fixed timer.

The shared setup (seeding, forge, server, signed or token deliveries, payload
builders, state-database reads) lives in `helpers/gitlab-webhook-scenario.ts`.

### GitLab CI, conflict and shared-token deliveries

`tests/local/webhook-gitlab-ci-sync.test.ts` reuses that setup for the `ci`
and `sync` delivery kinds and for the `X-Gitlab-Token` mode. It needs only the
built CLI and runs in the default offline suite:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

- Pipeline Hook: the forge's opt-in `ci` option serves one failed pipeline and
  job for the MR head, plus that job's trace. A `running` pipeline is
  acknowledged with no forge request. A `failed` pipeline for a stale SHA reads
  the MR but fetches no CI data and makes no agent run. A `failed` pipeline for
  the current head makes exactly one CI-repair run whose prompt carries the job
  name and trace markers, and pushes one commit on top of the old head. The
  payload carries the pipeline's own `object_attributes.iid`, which must not be
  read as the MR iid.
- Job Hook: a `success` job is ignored. A `failed` job matches the MR by branch
  (Job Hooks carry no MR iid) and runs the same repair.
- Merge Request Hook `detailed_merge_status: conflict`: the target branch has
  a conflicting commit. One conflict-resolution agent run happens, and the MR
  branch gets a merge commit whose parents are the old head and the target tip.
  The push is a fast-forward, not a force push. The branch now merges cleanly,
  and the target branch and the MR merge endpoint are untouched.
- Merge Request Hook `detailed_merge_status: need_rebase`: the target moved
  without conflicts. The same resolve path merges it with no agent run, pushes
  the merge commit, and posts one MR note.
- `X-Gitlab-Token` mode (`GITLAB_WEBHOOK_SECRET`, no signing token): a wrong or
  missing token returns 401 with no forge request, agent run or queue row. The
  matching token runs address-review as in the signed test. A replay with the
  same `Idempotency-Key` is a duplicate.

Isolation and cleanup match the review test. The webhook secret, forge token,
shared token and a wrong token are random per run. Tests assert that none of
them appears in server output, raw or URL-encoded.

### GitLab secret precedence, legacy `merge_status` and stale-SHA deliveries

`tests/local/webhook-gitlab-delivery-drift.test.ts` reuses the same setup for
payload and auth shapes that differ between GitLab versions. It needs only the
built CLI and runs in the default offline suite:

```sh
bun run --filter @getdevintern/code build
bun run --filter @devintern/e2e test
```

- Both secrets configured (`GITLAB_WEBHOOK_SECRET` and
  `GITLAB_WEBHOOK_SIGNING_TOKEN`): a delivery signed with a random unknown
  `whsec_` secret is rejected with 401 even when it also carries the correct
  `X-Gitlab-Token`. The same goes for a forged signature alone and for a
  delivery with neither header. None of them makes a forge request, an agent
  run or a queue row. A token-only delivery with the right token is accepted
  and settled. A correctly signed note on the registered MR runs
  address-review. The forged-signature-plus-token delivery is still refused
  after that run.
- Legacy mergeability: Merge Request Hooks built by `mergeabilityHook` with
  `legacyOnly`, so they carry `merge_status` and no `detailed_merge_status`.
  `can_be_merged` is acknowledged with no forge request or agent run.
  `cannot_be_merged` on a branch that really conflicts runs one
  conflict-resolution run, with the same merge-commit and fast-forward checks
  as the `detailed_merge_status: conflict` test.
- Stale head SHA: `advanceAgentBranch` pushes a commit to the MR branch through
  a throwaway clone, so the fake forge reports a newer head. A conflict Merge
  Request Hook, a failed Job Hook and a failed Pipeline Hook that name the old
  SHA are each accepted (200, one matched MR) and settle. The MR is read, but
  no CI data is fetched, no agent runs, and nothing is pushed or written. The
  same conflict delivery or failed Job Hook naming the current head then runs
  conflict resolution or CI repair, which shows the head-SHA guard is what
  skipped the stale ones. For the CI case, `FakeGitlabForge.setCiSha` moves the
  served failed pipeline to the new head.

Waits poll the delivery dedupe row in the state database, never a fixed timer.
Isolation, random credentials, the no-secret-in-output assertions and cleanup
match the tests above.
