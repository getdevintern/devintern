# License API contract

`@devintern/license-check` validates paid Polar entitlements and the authenticated Worker Pilot against the private `devintern.com` API.

## Worker Pilot

The pilot is server-authoritative. The CLI never derives eligibility or expiry from account age or local files.

`GET /api/license/check?productKey=devintern%2Fcode&server=1&trial=1` uses the existing bearer-token entitlement endpoint. Paid entitlements keep their existing response. An eligible or active trial returns:

```json
{
  "entitled": true,
  "source": "worker-trial",
  "trial": { "status": "available" }
}
```

An active trial uses `"status": "active"` and also returns an ISO `endsAt`. Expired and ineligible trials return the normal `entitled: false` response with a human-readable `reason`.

`POST /api/license/trial` with `{ "productKey": "devintern/code" }` atomically activates an eligible trial and returns the active response. Repeated activation is idempotent and must not move `endsAt`.

The pilot lasts 14 calendar days from activation, with no task-count limit. Trial responses are deliberately excluded from the paid-entitlement cache and its 72-hour outage grace. The relay may be connected during setup, but it only delivers events after activation.
