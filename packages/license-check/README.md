# License API contract

`@devintern/license-check` validates paid Polar entitlements and the authenticated Worker Pilot against the private `devintern.com` API.

## Worker Pilot

The pilot is server-authoritative. The CLI never derives eligibility or expiry from account age or local files.

`GET /api/license/check?productKey=devintern%2Fcode&server=1&trial=1` uses the existing bearer-token entitlement endpoint. Paid entitlements keep their existing response. An eligible or active trial returns:

```json
{
  "entitled": true,
  "source": "worker-trial",
  "trial": {
    "status": "available",
    "tasksRemaining": 10
  }
}
```

An active trial uses `"status": "active"` and also returns an ISO `endsAt`. Expired, exhausted, and ineligible trials return the normal `entitled: false` response with a human-readable `reason`.

`POST /api/license/trial` with `{ "productKey": "devintern/code" }` atomically activates an eligible trial and returns the active response. Repeated activation is idempotent and must not move `endsAt`.

`POST /api/license/trial/task` with `{ "productKey": "devintern/code", "taskFingerprint": "<sha256>" }` atomically reserves one task. The fingerprint is computed locally from the authenticated user id and task identity, so raw tracker keys and paths are never sent. Repeated claims with the same authenticated user and fingerprint are idempotent and return the current active response without decrementing twice. A successful response includes the post-claim `tasksRemaining`; exhausted or expired trials return a non-2xx response.

The intended policy is 14 calendar days or 10 distinct worker task claims, whichever comes first. Trial responses are deliberately excluded from the paid-entitlement cache and its 72-hour outage grace.
