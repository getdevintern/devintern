# Contributing

Thanks for wanting to improve DevIntern. A few things about how this repository works so your contribution lands smoothly.

## How this repo is maintained

This repository is the canonical home for DevIntern's product and tool source. Changes are reviewed and merged here through normal pull requests. The marketing site, account and checkout flows, and backend services live in a separate private repository and must not be added here.

## Before you start

- For anything larger than a small fix, please open an issue first so we can agree on the approach before you invest time.
- Check [AGENTS.md](AGENTS.md) for tooling rules (Bun only: no node/npm/pnpm/jest/vitest) and per-package guidance.

## Repository layout

| Package                                        | Purpose                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| [`@getdevintern/code`](packages/code)          | The worker and CLI: ticket → agent → PR → review follow-up       |
| [`@getdevintern/pm`](packages/pm)              | The `devpm` CLI: rough input → well-specified tickets            |
| [`@devintern/pm-desktop`](packages/pm-desktop) | Desktop app for ticket drafting: prompt, log, or Figma → tracker |
| `packages/*` (shared)                          | Agent harness, tracker clients, auth, license check, utilities   |

## Development workflows

Install dependencies with `bun install`, then use the root commands below. Turborepo runs package tasks in parallel where it is safe and orders workspace builds according to their package dependencies.

| Command                | Purpose                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `bun run build`        | Build every workspace and its dependencies                                    |
| `bun run test`         | Run all package test suites                                                   |
| `bun run lint`         | Lint all packages                                                             |
| `bun run typecheck`    | Type-check all packages                                                       |
| `bun run format:check` | Check formatting without changing files                                       |
| `bun run format`       | Format all packages; this write task is intentionally not cached              |
| `bun run dev`          | Start the dashboard and desktop watch tasks; stop them with <kbd>Ctrl+C</kbd> |

Package-level commands remain available, for example `bun run --filter @getdevintern/pm test`. To run a selected task and its dependency graph through Turborepo, use `bun run turbo run build --filter @getdevintern/code`.

Turborepo uses the local `.turbo` directory for its cache; remote caching is not configured. Add `--force` to a Turbo command to ignore cached results, or remove `.turbo` to clear the local cache completely. If a result looks stale, first rerun it with `--force`; changes to the lockfile, package sources, shared lint configuration, or declared build environment variables automatically invalidate affected entries.

## Ground rules

- `bun install`, then `bun run format`, `bun run lint`, `bun run typecheck`, `bun run test` must pass. These root commands use Turborepo; the lefthook pre-commit hook runs the first three automatically.
- Tests use isolated temp directories; do not share temp dirs across tests.
- Keep changes scoped to the product packages and documentation in this repo. Website and docs-site implementation changes happen elsewhere.
- Update the relevant guide under `docs/{code,pm}` when a change alters user-facing CLI behavior, flags, or environment variables.

## Sign-off (DCO)

By contributing, you certify the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change or have the right to submit it under this repository's license (FSL-1.1-ALv2). Please add a `Signed-off-by:` line to your commits (`git commit -s`).

## Reporting issues

Bug reports and feature requests are welcome in the issue tracker. For anything security-sensitive, email security@devintern.com instead of opening a public issue.
