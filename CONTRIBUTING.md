# Contributing

Thanks for wanting to improve DevIntern. A few things about how this repository works so your contribution lands smoothly.

## How this repo is maintained (please read before opening a PR)

Day-to-day development currently happens in a private monorepo that also contains the devintern.com website and its server code. This public repository receives regular snapshots of the tool packages.

What that means for pull requests:

- **Your PR is welcome and will be reviewed here.** Discussion, review comments, and iteration all happen on your PR as usual.
- **It will not be merged with the green button.** Once approved, we apply your commits to the private repository with `git am`, preserving you as the commit author, and your change ships in the next public sync. We then close your PR with a comment linking the sync commit that contains your change.
- Your authorship is preserved in the public history (same name, same email, `Co-authored-by` where squashing was needed).

This is a transitional setup: once the current internal PR queue drains, development of the tool packages moves to this repository and PRs merge normally. This file will be updated when that happens.

## Before you start

- For anything larger than a small fix, please open an issue first so we can agree on the approach before you invest time.
- Check `AGENTS.md` for the monorepo layout, tooling rules (Bun only: no node/npm/pnpm/jest/vitest), and per-package commands.

## Ground rules

- `bun install`, then `bun run format`, `bun run lint`, `bun run typecheck`, `bun run test` must pass. The lefthook pre-commit hook runs the first three automatically.
- Tests use isolated temp directories; do not share temp dirs across tests.
- Keep changes scoped to the tool packages in this repo. Website and docs-site changes happen elsewhere; if your change alters user-facing CLI behavior, mention it in the PR description so the docs at devintern.com get updated alongside the release.

## Sign-off (DCO)

By contributing, you certify the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change or have the right to submit it under this repository's license (FSL-1.1-Apache-2.0). Please add a `Signed-off-by:` line to your commits (`git commit -s`).

## Reporting issues

Bug reports and feature requests are welcome in the issue tracker. For anything security-sensitive, email security@devintern.com instead of opening a public issue.
