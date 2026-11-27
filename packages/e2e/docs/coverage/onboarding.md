# Onboarding golden path e2e coverage

Scope: a first-time user's whole setup on a blank Linux host, in one run: installing the CLI, `worker init` (non-interactive and the wizard), `worker doctor`, the systemd service, and the first tracker issue becoming a PR. Each command is covered in more depth by [worker-commands.md](worker-commands.md) and [worker-daemon.md](worker-daemon.md); this file covers the chain, so a regression that only shows end to end (PATH after a global install, git credentials on a fresh host, a service that crash-loops, the user bus under `docker exec`) fails CI.

Status values are defined in the [coverage index](../coverage-matrix.md#status-legend).

## Coverage

### Golden path from source: install, init, doctor, service, issue to PR, wizard

- Surface: External dependency: GitHub.com (Issues and PRs on the fixture repository), systemd, npm registry (CLI dependencies) | `devintern worker` surface
- Status: `live`
- Evidence: `tests/golden-path/golden-path.test.ts` (`bun run --filter @devintern/e2e test:e2e:golden-path`; needs Docker and the GitHub fixture). Runs nightly, before every `@getdevintern/code` release, and on pull requests that change the suite (`.github/workflows/onboarding-golden-path.yml`). Cleanup: `afterAll` closes the run's issue and PR, deletes its `e2e/golden-<id>` base and `feature/<issue>` branches and its `e2e-golden-<id>` label, and removes the container; the shared `e2e: …` status labels are kept.
- Missing: real sign-in (the license skip flag stands in for it), relay pairing, a real agent CLI, launchd/macOS.
- Last reviewed: 2026-11-26

### Golden path against the published npm package (release build)

- Surface: External dependency: npm registry, GitHub.com | `devintern worker` surface
- Status: `live`
- Evidence: `tests/golden-path/golden-path.test.ts` with `DEVINTERN_CLI_SOURCE=npm:<version|latest>` (or `release-tarball:<path>` for a local release build). Runs after every code release against the version just published (`smoke-published-code` in `npm-release.yml`) and opens or updates an `onboarding-regression` issue on failure; a version still not on npm after 15 minutes opens an `npm-propagation` issue instead.
- Missing: the PR and service lifecycle steps, which need a signed-in account in a release build.
- Last reviewed: 2026-11-26

## Backlog

- Priority 20: a CI account that can complete the Worker Pilot sign-in headlessly (`worker login --no-wait` / `--complete`), so the release-build golden path can run the service and PR steps too.

## Test notes

### Onboarding golden path

- Proves, in order, each step stopping the rest when it fails (the first `(fail)` line names the broken step):
  1. `bun add -g` from a login shell puts `devintern` on a new login shell's `PATH` (`~/.bun/bin`, set only by `~/.profile`), on a host with no git identity or credential helper.
  2. `worker init --non-interactive --tracker github --task-query 'is:open label:<unique>' --repo-from-cwd --env-file <0600> --json` on a clone of a unique base branch: `action_required`, exit 2, no failing check, the tracker probe passes, sign-in is the first next step, and the saved `.env` is 0600.
  3. Source build: `worker doctor --json` succeeds with `setup: ready` and a `service` next step once `DEVINTERN_SKIP_LICENSE_CHECK=1` stands in for sign-in. Release build: doctor still reports `action_required` (exit 2) and `setup: action_required` with `sign-in` as the first next step, because release builds ignore the flag.
  4. Source build: `worker service install --json` from a plain `docker exec` (no `XDG_RUNTIME_DIR` or bus address) reports `running` with the pid systemd reports, and the unit runs the user's Bun; installing again reports `unchanged` with the same pid, and doctor then says `setup: complete`. Release build: install refuses with `action_required` (exit 2), next steps `sign-in` then `service`, and writes no unit.
  5. Source build: a labelled issue is picked up by the service worker, which clones with `GITHUB_TOKEN` (no git config on the host), opens a PR from `feature/<issue>` into the unique base with only `src/greeting.ts` changed, moves the status labels, posts the implementation comment, and skips the issue on a later poll; the agent ran once.
  6. Source build: `service stop` leaves the unit `inactive` with `Result=success` and status `stopped`; `restart` reports the new pid; `uninstall` removes the unit and status says `not_installed`.
  7. Both builds: the wizard on a PTY (`docker exec -it` inside a Bun terminal) for a second user with an untouched home: markdown tracker, the recommended worker settings accepted, sign-in, relay and service declined. It must end with "One step left: sign in", no `❌`, no "setup complete", and exit 2.
- How: `scripts/golden-path.ts` resolves the GitHub fixture (as `test:e2e`), packs the built CLI (or resolves the npm version, waiting up to 15 minutes with backoff for a fresh publish, via `helpers/npm-visibility.ts`), and builds `infrastructure/golden-path/Dockerfile`: systemd as PID 1, Bun in each user's `~/.bun/bin` with its `PATH` line in `~/.profile`, and no CLI. `helpers/systemd-container.ts` starts one privileged container per run and enables lingering as root (a stand-in for a login session); `login()` runs every user command with `bash -l` and no TTY. Secrets reach the container on stdin only. The test edits `workspace.toml` after init to pin the unique base (`default_branch`, `--pr-target-branch`), poll every 5 s, and set status labels. The deterministic agent is linked as `~/.local/bin/claude`.
- Run: `bun run --filter @devintern/e2e test:e2e:golden-path`; `DEVINTERN_CLI_SOURCE=npm:latest` for the published package.
- Prerequisites: Docker with privileged containers, network access, and the GitHub fixture credentials from [README](../../README.md#onboarding-golden-path). About 1-2 minutes from source and under a minute for a release build, plus about a minute for the first image build.
