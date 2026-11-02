# Flaky test triage

Find and stabilize intermittent test failures.

1. Run the test suite repeatedly (at least twice) using the project's documented
   test command.
2. Compare the runs and collect evidence for any test that passes in one run and
   fails in another. Include the failing assertion or error output.
3. Pick at most **one** confirmed flaky test and make the smallest change that
   removes the source of nondeterminism (for example: a race, an unawaited
   operation, shared mutable state, or a timing assumption).
4. Re-run the affected test several times to confirm the fix, and run the full
   suite once more.

Do not weaken or delete assertions to make a test pass, and do not change
unrelated production code. If you cannot confirm a fix with repeated runs,
report the evidence instead of guessing.
