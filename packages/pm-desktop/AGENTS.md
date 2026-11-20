# AGENTS.md

Guidance for coding agents working on `@devintern/pm-desktop`. Repo-wide rules (Bun-only tooling, lint, format, docs) are in the root [AGENTS.md](../../AGENTS.md).

## Overview

Electron app built with electron-vite; React + shadcn/ui renderer. It is the desktop front end for `@getdevintern/pm`: multi-ticket AI task creation for your tracker.

## Runtime

- Electron `43.3.0`, pinned exactly (electron-builder rejects ranges), with `electron-vite` `^5.0.0`
- Requires macOS 12+ (Electron dropped 11 in v38)
- Electron 42+ downloads its binary lazily on the first `electron`/`electron-vite` run (no npm `postinstall`); root `trustedDependencies` still lists `electron` for Bun lifecycle trust

## Commands

- Dev: `bun run dev`
- Build: `bun run build` (output in `out/`, not committed)
- Package installers: `bun run package` / `package:linux|mac` (electron-builder → `release/`). Public macOS releases are Developer ID signed and notarized; see `README.md` and `RELEASE.md`

## Releases and auto-update

- Binaries ship as **published** GitHub Releases on this repo (`pm-desktop-v*`) with installers + `latest-mac.yml` / `latest-linux.yml`. Source sync via the monorepo allowlist is separate from the binary feed
- Auto-update uses `electron-updater` against those published Releases (packaged builds only; no-op in dev)

## Architecture

- Reuses the pm engine via `@getdevintern/pm/engine` and `@getdevintern/pm/config`; issue-type defaults via `@getdevintern/pm/issue-types`; in-app project setup via `@getdevintern/pm/init` (main) and `@getdevintern/pm/init-shared` (renderer-safe metadata)
- Multi-ticket workspaces: sidebar of open tickets with independent composer/output state; agent streams route by `requestId` (see `src/renderer/src/state/ticket-workspaces.ts`)
- Harness switching (header pill) persists `AGENT_HARNESS` the same way as the CLI; see `packages/pm/AGENTS.md`

## Analytics

Anonymous product analytics (PostHog): set `POSTHOG_API_KEY` (and optional `POSTHOG_HOST`) at **build** time via `packages/pm-desktop/.env` (see `.env.example`), shell, or CI so electron-vite can bake them into the main bundle; a missing key makes analytics no-op. Users can opt out in Settings.
