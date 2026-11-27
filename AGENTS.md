# AGENTS.md

## Monorepo Overview

Bun-based monorepo with workspace packages under `packages/*`. The marketing site (devintern.com) and its server code live in a separate repository.

| Package                        | Role                                                                                                                          | Published       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `@getdevintern/code`           | CLI for task automation (`devintern`): Jira + multi-PM support, configurable AI agent                                         | yes             |
| `@getdevintern/pm`             | CLI for PM task/story creation (`devpm`): supports Jira, Linear, Trello, Azure DevOps, Asana, GitHub Issues, GitLab, Markdown | yes             |
| `@devintern/pm-desktop`        | Electron desktop app for `@getdevintern/pm`: multi-ticket AI task creation for your tracker                                   | no, private     |
| `@devintern/agent-harness`     | Shared agent harness abstraction                                                                                              | no, source-only |
| `@devintern/dashboard-ui`      | Local observability dashboard UI (Vite + React), bundled into `@getdevintern/code` at build time                              | no, source-only |
| `@devintern/auth`              | Shared Supabase auth utilities (CLI login/session)                                                                            | no, source-only |
| `@devintern/license-check`     | Shared license checking                                                                                                       | no, source-only |
| `@getdevintern/license-policy` | Shared entitlement policy and secretless Polar key validation                                                                 | no, source-only |
| `@devintern/text-formatter`    | Shared text formatting                                                                                                        | no, source-only |
| `@devintern/utils`             | Shared utilities (`fetchWithRetry`, CLI auto-update check, etc.)                                                              | no, source-only |
| `@devintern/task-trackers`     | Shared task tracker config and API clients (Jira, Linear, Trello, etc.)                                                       | no, source-only |
| `@devintern/workspace`         | Shared read access to the `~/.devintern` workspace (paths, a checkout's `[[repos]]` entry, its credentials)                   | no, source-only |

**Tooling:** Bun exclusively: runtime, package manager, bundler, and test runner. Do not use `node`, `npm`, `pnpm`, `jest`, or `vitest`.

## Developer Commands

```bash
# Root: Turborepo runs tasks across all packages
bun install
bun run build
bun run dev
bun run typecheck
bun run test
bun run format
bun run lint

# Bypass a cached result while troubleshooting
bun run turbo run test --force

# Single package
bun run --filter @getdevintern/code test
bun run --filter @getdevintern/pm build
```

**Pre-commit (lefthook):** runs `format` (with `stage_fixed`), then `lint`, then `typecheck` sequentially (not parallel). If you commit manually without lefthook, run them in that order.

## Package-Specific Notes

Packages with more involved rules keep their own `AGENTS.md` (listed under [References](#references)); read it before changing code there.

### `@getdevintern/code`

- Entry: `src/index.ts`; run locally: `bun start TASK-123`
- Build: `bun run build.ts`: bundles with `Bun.build`, then replaces shebang from `node` to `bun` in `dist/index.js`
- Tests: always `bun run test` from `packages/code`; bare `bun test` is refused. Single-file and filter usage, and the state isolation rules, are in `packages/code/AGENTS.md`
- Uses `bun:sqlite` for the webhook queue

### `@getdevintern/pm`

- Entry: `index.ts` (flat, no `src/`); `ink` + `react` TSX in `lib/`; run locally: `bun run index.ts`
- Application code is portable: Node.js built-ins via `lib/runtime/`, no `Bun.*` runtime APIs. Build (`build.ts`) targets Node.js so the bundle runs under plain Node.js and Electron. Details in `packages/pm/AGENTS.md`

### `@devintern/pm-desktop`

- Electron app (electron-vite, React + shadcn/ui renderer) that reuses the pm engine. Runtime pins, packaging, releases, and analytics are in `packages/pm-desktop/AGENTS.md`

### Source-only shared packages

`agent-harness`, `auth`, `license-check`, `license-policy`, `text-formatter`, `utils`, `task-trackers`, `workspace`:

- No build step. `build` script just echoes.
- Consumed directly via `"exports": { ".": "./src/index.ts" }`.
- Other packages depend on them via `"workspace:*"`.

## TypeScript / Lint / Format

- Formatter: `oxfmt` (not Prettier)
- Linter: `oxlint` (not ESLint)
- Root `.oxlintrc.json` is the shared baseline; nested config discovery applies it to every package's `oxlint .`. Plugins: `typescript`, `unicorn`, `oxc`, `react`, `jsdoc`, `import`, `promise`. `categories.correctness` stays at `warn`; all configured `react/*` rules (including hooks) and enabled import hygiene rules (`import/no-cycle`, `no-duplicates`, `first`, etc.) are `error`. Export-layout rules (`import/group-exports`, `import/exports-last`) stay `off` — they ban the monorepo's inline `export function`/`export type` style. CommonJS is allowed only in `*.{cjs,cts}` via override. Noisy JSDoc `require-*` rules for typed codebases (`require-param-type`, `require-returns-type`, etc.) are off. Side-effect imports (CSS, `dotenv/config`) use `oxlint-disable-next-line import/no-unassigned-import` with a reason.
- Strict TypeScript with `bun-types`, `moduleResolution: bundler`, `allowImportingTsExtensions: true`
- `packages/code` has `noUncheckedIndexedAccess: false` (differs from `packages/pm` which enables it)
- Coding standards: [CODING_STANDARDS.md](CODING_STANDARDS.md) — parse external data into a named domain type where it crosses the boundary. `.oxlintrc.json` enforces `typescript/no-explicit-any` and `typescript/ban-types`; tests are exempt, and a ratchet-baseline override lists files with pre-existing `any` to shrink over time

## Documentation

Product documentation lives in `docs/{code,pm}` and is also rendered at https://devintern.com/docs. Update the relevant Markdown guide when changing user-facing CLI behavior, flags, or environment variables.

Write docs for people installing and operating DevIntern, not for contributors:

- Cover what a feature does, when to use it, how to turn it on, the settings users actually set (with defaults), and fixes for common problems. Add new content to the page that owns the topic and link to it from elsewhere instead of repeating it.
- Leave out implementation internals: queue or database mechanics, retry and backoff algorithms, race conditions, internal file layouts, and step-by-step code paths. Those belong in code comments or `packages/*/AGENTS.md`.
- Keep it short: one example per concept, tables for lists of options, no long sample output. Put niche settings in a compact reference table instead of a new prose section.
- Keep page slugs stable, because the product and the website link to them. If a page grows past about 250 lines, split it: the original page becomes an overview that links to the new pages, and each new page gets full frontmatter. When you move or rename a heading, update every link to its old anchor.

## References

- `packages/code/AGENTS.md`: detailed architecture for `@getdevintern/code` (workflows, module layout, config, test runner and state isolation)
- `packages/pm/AGENTS.md`: portable runtime rules (`lib/runtime/` helpers), CLI patterns, harness switching
- `packages/pm-desktop/AGENTS.md`: Electron runtime pins, packaging, releases, auto-update, analytics

`AGENTS.md` is the only agent instruction file in this repo: Claude Code (v2.1.281+), Codex, and other agents all read it, including the nested ones. Do not add a `CLAUDE.md`; `bun run lint` fails on a tracked one. For private notes use an untracked `CLAUDE.local.md` with Claude Code's Project instructions setting at `claude-md-and-agents-md` (otherwise its presence stops `AGENTS.md` from loading).
