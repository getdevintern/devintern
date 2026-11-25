Find the slowest tests in this repository and make one bounded optimization that preserves quality.

0. Read the repository's contributor docs (AGENTS.md, CLAUDE.md, CONTRIBUTING.md) for the documented test commands and conventions. Deduplicate: if an open pull request from this automation (search open PRs whose title contains this automation's id, the task title above) already exists, make no changes and report it.

1. Measure per-test durations for each package or module that owns tests. Prefer the runner's machine-readable output, for example a JUnit report (`--reporter=junit`, `pytest --junitxml`, `go test -json`, `cargo nextest` with JUnit output), and rank the slowest tests and files.

2. Choose one target with a real, fixable cost: fixed sleeps or timeouts, real network calls, spawning servers or child processes, real filesystem or database work, heavy setup repeated per test, or unnecessarily sequential awaits. Do not target a test that is slow because exercising the system end to end is its point.

3. Optimize while keeping the test's assertions and coverage. Legitimate techniques: replacing fixed sleeps with deterministic waits or fake timers, mocking the network at the boundary, sharing expensive setup across tests where isolation is not required, in-memory fixtures or databases, and parallelizing independent work. Do not delete tests, weaken or remove assertions, skip tests, widen timeouts, or swap real coverage for trivial checks.

4. Guard against flakiness: run the changed test file at least 10 times in a row and confirm every run passes, then run the affected package's full suite once. Record the target's measured time before and after. If it does not pass 10 consecutive runs, revert the change and report that instead.

5. If no test is worth optimizing (everything is near the measurement noise floor), make no changes and report the slowest tests with their measured times.

The pipeline commits your changes and opens a pull request. Report the slowest tests with before and after timings, the one you optimized, the technique used, and the 10-run verification result.
