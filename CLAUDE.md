# AGENTS.md

## Monorepo Overview

Bun-based monorepo with workspace packages under `packages/*`. The marketing site (devintern.com) and its server code live in a separate repository.

| Package                        | Role                                                                                                                  | Published       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------- |
| `@getdevintern/code`           | CLI for task automation (`devintern`): Jira + multi-PM support, configurable AI agent                                 | yes             |
| `@getdevintern/pm`             | CLI for PM task/story creation (`devpm`): supports Jira, Linear, Trello, Azure DevOps, Asana, GitHub Issues, Markdown | yes             |
| `@devintern/pm-desktop`        | Electron desktop app for `@getdevintern/pm`: multi-ticket AI task creation for your tracker                           | no, private     |
| `@devintern/agent-harness`     | Shared agent harness abstraction                                                                                      | no, source-only |
| `@devintern/dashboard-ui`      | Local observability dashboard UI (Vite + React), bundled into `@getdevintern/code` at build time                      | no, source-only |
| `@devintern/auth`              | Shared Supabase auth utilities (CLI login/session)                                                                    | no, source-only |
| `@devintern/license-check`     | Shared license checking                                                                                               | no, source-only |
| `@getdevintern/license-policy` | Shared entitlement policy and secretless Polar key validation                                                         | no, source-only |
| `@devintern/text-formatter`    | Shared text formatting                                                                                                | no, source-only |
| `@devintern/utils`             | Shared utilities (`fetchWithRetry`, CLI auto-update check, etc.)                                                      | no, source-only |
| `@devintern/task-trackers`     | Shared task tracker config and API clients (Jira, Linear, Trello, etc.)                                               | no, source-only |

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

### `@devintern/pm-desktop`

- Electron app built with electron-vite; React + shadcn/ui renderer
- Runtime pin: Electron `43.3.0` (exact — electron-builder rejects ranges) with `electron-vite` `^5.0.0`. Requires macOS 12+ (Electron dropped 11 in v38). Electron 42+ downloads its binary lazily on first `electron`/`electron-vite` run (no npm `postinstall`); root `trustedDependencies` still lists `electron` for Bun lifecycle trust.
- Dev: `bun run dev`; build: `bun run build` (output in `out/`, not committed)
- Package installers: `bun run package` / `package:linux|mac` (electron-builder → `release/`). Public macOS releases are Developer ID signed and notarized; see `packages/pm-desktop/README.md` and `RELEASE.md`
- Binaries: **published** GitHub Releases on this repo (`pm-desktop-v*`) with installers + `latest-mac.yml` / `latest-linux.yml` (source sync via the monorepo allowlist is separate from the binary feed)
- Auto-update via `electron-updater` against those published Releases (packaged builds only; no-op in dev)
- Reuses the pm engine via `@getdevintern/pm/engine` and `@getdevintern/pm/config`; issue-type defaults via `@getdevintern/pm/issue-types`; in-app project setup via `@getdevintern/pm/init` (main) and `@getdevintern/pm/init-shared` (renderer-safe metadata)
- Multi-ticket workspaces: sidebar of open tickets with independent composer/output state; agent streams route by `requestId` (see `renderer/src/state/ticket-workspaces.ts`)
- Anonymous product analytics (PostHog): set `POSTHOG_API_KEY` (and optional `POSTHOG_HOST`) at **build** time via `packages/pm-desktop/.env` (see `.env.example`), shell, or CI so electron-vite can bake them into the main bundle; missing key → analytics no-ops. Users can opt out in Settings.

### Source-only shared packages

`agent-harness`, `auth`, `license-check`, `license-policy`, `text-formatter`, `utils`, `task-trackers`:

- No build step. `build` script just echoes.
- Consumed directly via `"exports": { ".": "./src/index.ts" }`.
- Other packages depend on them via `"workspace:*"`.

## TypeScript / Lint / Format

- Formatter: `oxfmt` (not Prettier)
- Linter: `oxlint` (not ESLint)
- Root `.oxlintrc.json` is the shared baseline; nested config discovery applies it to every package's `oxlint .`. Plugins: `typescript`, `unicorn`, `oxc`, `react`, `jsdoc`, `import`, `promise`. `categories.correctness` stays at `warn`; all configured `react/*` rules (including hooks) and enabled import hygiene rules (`import/no-cycle`, `no-duplicates`, `first`, etc.) are `error`. Export-layout rules (`import/group-exports`, `import/exports-last`) stay `off` — they ban the monorepo's inline `export function`/`export type` style. CommonJS is allowed only in `*.{cjs,cts}` via override. Noisy JSDoc `require-*` rules for typed codebases (`require-param-type`, `require-returns-type`, etc.) are off. Side-effect imports (CSS, `dotenv/config`) use `oxlint-disable-next-line import/no-unassigned-import` with a reason.
- Strict TypeScript with `bun-types`, `moduleResolution: bundler`, `allowImportingTsExtensions: true`
- `packages/code` has `noUncheckedIndexedAccess: false` (differs from `packages/pm` which enables it)

## Documentation

Product documentation lives in `docs/{code,pm}` and is also rendered at https://devintern.com/docs. Update the relevant Markdown guide when changing user-facing CLI behavior, flags, or environment variables.

## References

- `packages/code/CLAUDE.md`: detailed architecture for `@getdevintern/code` (workflows, config, output structure)
- `packages/pm/CLAUDE.md`: Bun CLI patterns, file I/O, shell commands
