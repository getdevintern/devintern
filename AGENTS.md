# AGENTS.md

## Monorepo Overview

Bun-based monorepo with workspace packages under `packages/*`. The marketing site (devintern.com) and its server code live in a separate repository.

| Package                     | Role                                                                                                                    | Published       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------- |
| `@getdevintern/code`        | CLI for task automation (`devintern`): Jira + multi-PM support, configurable AI agent                                   | yes             |
| `@getdevintern/pm`          | CLI for PM task/story creation (`devpm`): supports Jira, Linear, Trello, Azure DevOps, Asana, GitHub Issues, Markdown   | yes             |
| `@devintern/agent-harness`  | Shared agent harness abstraction                                                                                        | no, source-only |
| `@devintern/auth`           | Shared Supabase auth utilities (CLI login/session)                                                                      | no, source-only |
| `@devintern/license-check`  | Shared license checking                                                                                                 | no, source-only |
| `@devintern/text-formatter` | Shared text formatting                                                                                                  | no, source-only |
| `@devintern/utils`          | Shared utilities (`fetchWithRetry`, etc.)                                                                               | no, source-only |
| `@devintern/task-trackers`  | Shared task tracker config and API clients (Jira, Linear, Trello, etc.)                                                 | no, source-only |

**Tooling:** Bun exclusively: runtime, package manager, bundler, and test runner. Do not use `node`, `npm`, `pnpm`, `jest`, or `vitest`.

## Developer Commands

```bash
# Root: run across all packages
bun install
bun run build
bun run typecheck
bun run test
bun run format
bun run lint

# Single package
bun run --filter @getdevintern/code test
bun run --filter @getdevintern/pm build
```

**Pre-commit (lefthook):** runs `format` (with `stage_fixed`), then `lint`, then `typecheck` sequentially (not parallel). If you commit manually without lefthook, run them in that order.

## Package-Specific Notes

### `@getdevintern/code`

- Entry: `src/index.ts`
- Tests: `bun test` (Bun native test runner in `tests/`)
- Build: `bun run build.ts`: bundles with `Bun.build`, then replaces shebang from `node` to `bun` in `dist/index.js`
- Run locally: `bun start TASK-123`
- Tests use isolated temp directories, essential for parallel execution (do not share temp dirs across tests)
- Uses `bun:sqlite` for webhook queue

### `@getdevintern/pm`

- Entry: `index.ts` (flat, no `src/`)
- Uses `ink` (React for CLI) + `react`: JSX/TSX files in `lib/`
- Build: `bun build index.ts --target=bun --outdir=dist --format=esm --external=ink --external=react --external=ink-scroll-view --minify`
- Run locally: `bun run index.ts`

### Source-only shared packages

`agent-harness`, `auth`, `license-check`, `text-formatter`, `utils`, `task-trackers`:

- No build step. `build` script just echoes.
- Consumed directly via `"exports": { ".": "./src/index.ts" }`.
- Other packages depend on them via `"workspace:*"`.

## TypeScript / Lint / Format

- Formatter: `oxfmt` (not Prettier)
- Linter: `oxlint` (not ESLint)
- Strict TypeScript with `bun-types`, `moduleResolution: bundler`, `allowImportingTsExtensions: true`
- `packages/code` has `noUncheckedIndexedAccess: false` (differs from `packages/pm` which enables it)

## Documentation

Product documentation lives at https://devintern.com/docs. When changing CLI behavior, flags, or env vars, mention it in the PR description so the docs can be updated alongside the release.

## References

- `packages/code/CLAUDE.md`: detailed architecture for `@getdevintern/code` (workflows, config, output structure)
- `packages/pm/CLAUDE.md`: Bun CLI patterns, file I/O, shell commands
