# Contributing

Thanks for wanting to improve DevIntern. A few things about how this repository works so your contribution lands smoothly.

## How this repo is maintained

This repository is the canonical home for DevIntern's product and tool source. Changes are reviewed and merged here through normal pull requests. The marketing site, account and checkout flows, and backend services live in a separate private repository and must not be added here.

## Before you start

- For anything larger than a small fix, please open an issue first so we can agree on the approach before you invest time.
- Check `AGENTS.md` for the monorepo layout, tooling rules (Bun only: no node/npm/pnpm/jest/vitest), and per-package commands.

## Ground rules

- `bun install`, then `bun run format`, `bun run lint`, `bun run typecheck`, `bun run test` must pass. The lefthook pre-commit hook runs the first three automatically.
- Tests use isolated temp directories; do not share temp dirs across tests.
- Keep changes scoped to the product packages and documentation in this repo. Website and docs-site implementation changes happen elsewhere.
- Update the relevant guide under `docs/{code,pm}` when a change alters user-facing CLI behavior, flags, or environment variables.

## Sign-off (DCO)

By contributing, you certify the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change or have the right to submit it under this repository's license (FSL-1.1-Apache-2.0). Please add a `Signed-off-by:` line to your commits (`git commit -s`).

## Reporting issues

Bug reports and feature requests are welcome in the issue tracker. For anything security-sensitive, email security@devintern.com instead of opening a public issue.
