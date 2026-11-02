# Local log triage

Review recent local logs and turn the strongest signal into a durable fix.

1. Read the most recent logs available in this workspace (application logs,
   job/worker logs, and any CI logs that were captured locally).
2. Group failures by signature and ignore transient noise (network blips,
   restarts, rate limits).
3. Choose the **one** highest-confidence, reproducible defect.
4. If the cause is clear and the fix is small and safe, implement it, add a
   regression test, and run the project's checks.
5. If the cause is unclear or the fix is risky, write a concise report of the
   evidence and the suggested next step instead.

Do not make speculative changes. Do not touch more than the files needed for
the single defect you chose.
