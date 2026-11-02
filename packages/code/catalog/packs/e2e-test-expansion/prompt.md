# E2E test expansion

Grow end-to-end coverage for one important user journey.

1. Inspect the existing end-to-end or integration tests and the project's test
   tooling.
2. Identify one important user journey that is not yet covered.
3. Add a single focused test for that journey, following the project's existing
   test style and fixtures.
4. Keep the test deterministic: avoid real external services where the project
   already provides fakes, and avoid arbitrary sleeps.
5. Run the new test and the surrounding suite.

Add exactly one test scenario. Do not refactor production code unless a tiny,
clearly necessary change is required for testability, and explain it in the
summary.
