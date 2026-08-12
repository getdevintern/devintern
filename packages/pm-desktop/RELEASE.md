# pm-desktop releases

Versioned process for cutting installable `@devintern/pm-desktop` builds for macOS and Linux, including the public auto-update feed.

## Two channels (do not confuse)

| Channel | What it is | Who consumes it |
| ------- | ---------- | --------------- |
| **Source sync** | `publish/sync.sh` allowlists `packages/pm-desktop` into `getdevintern/devintern` | Contributors building from source |
| **Binary / update feed** | GitHub **Releases** on `getdevintern/devintern` with installers + `latest-*.yml` | Packaged apps (`electron-updater`) and early adopters downloading installers |

This document is about the **binary / update feed**. Source already ships via the allowlist; installable releases are a separate path.

## Early-adopter public releases (current default)

Until Apple Developer signing + notarization are enabled, we still ship **published** public releases so early adopters can install and dogfood without building from source.

| Expectation | Detail |
| ----------- | ------ |
| **Linux** | Smoother path — AppImage / `.deb` work without signing |
| **macOS** | **Unsigned** — Gatekeeper / quarantine friction is expected; not a Gatekeeper-clean install |
| **Quality** | Early-adopter / dogfood, not a marketed production download |
| **Update feed** | Same public release assets include `latest-mac.yml` / `latest-linux.yml` + blockmaps so packaged installs can discover updates once the release is **published** (not draft/prerelease) |

macOS auto-update **discovery** works against the public feed for unsigned builds; **applying** an update may still hit Gatekeeper (same “Open Anyway” / `xattr` steps). Manual download from the release page is always a fallback.

Signing/notarization remains the path to production-quality trust later — see [Blocked on certificates](#blocked-on-certificates--enablement-checklist). It is **not** a hard gate for opening the public feed.

## Cut a release

1. **Bump version** in `packages/pm-desktop/package.json` (semver). Keep it in sync with any tag you push.
2. **Commit** the bump on the release branch / main.
3. **Tag** (example):
   ```bash
   git tag pm-desktop-v0.2.0
   git push origin pm-desktop-v0.2.0
   ```
4. **Package** on each OS (native runners — do not cross-compile macOS), or let CI do it:
   ```bash
   # Linux runner / machine
   bun install
   bun run --filter @devintern/pm-desktop package:linux

   # macOS runner / machine
   bun run --filter @devintern/pm-desktop package:mac
   ```
5. **CI packaging** (`.github/workflows/pm-desktop-release.yml` on `pm-desktop-v*` tags):
   - Builds installers on Linux / macOS and uploads artifacts (including `latest-mac.yml` / `latest-linux.yml` and `*.blockmap`).
   - Verifies every artifact URL in `latest-*.yml` has an exact filename match before uploading. This catches GitHub filename normalization mismatches that would break auto-update downloads.
   - Creates a **private staging draft** on the repo that ran the workflow (typically this private monorepo). That draft is for humans to inspect — it is **not** the electron-updater feed.
   - **If** `PM_DESKTOP_PUBLIC_RELEASE_TOKEN` (PAT with `contents:write` on `getdevintern/devintern`) is set, CI also opens a **draft** release on the public update-feed repo `getdevintern/devintern` with the same tag, artifacts, and early-adopter release notes (macOS unsigned guidance when CSC secrets are unset).
   - macOS signing secrets (`PM_DESKTOP_CSC_*`) are **optional**: when present, packaging signs/notarizes; when absent, unsigned macOS still ships on the public draft (early-adopter path).
   - Without the PAT, tagging private `pm-desktop-v*` alone does **not** make packaged apps see an update — use [manual public-feed handoff](#manual-public-feed-handoff-when-ci-skips-the-public-draft).
6. **Smoke-test** one artifact per platform before going live (see [Smoke checks](#smoke-checks)).
7. **Publish the public feed** (undraft the release on `getdevintern/devintern`):
   - Open https://github.com/getdevintern/devintern/releases
   - Find the matching `pm-desktop-v*` **draft**, verify artifacts + yml/blockmap files, then **Publish release** (not prerelease).
   - Draft and prerelease tags are invisible to `electron-updater`'s "latest" channel.
   - Keep or discard the private monorepo draft; clients never read it.
   - Confirm the published release body still sets unsigned-macOS / early-adopter expectations (CI pre-fills this; edit if needed before publishing).

### Manual public-feed handoff (when CI skips the public draft)

If `PM_DESKTOP_PUBLIC_RELEASE_TOKEN` was missing (or you packaged only locally):

1. Download the private staging draft assets (or local `packages/pm-desktop/release/` outputs).
2. Create a release on `getdevintern/devintern` with tag `pm-desktop-vX.Y.Z` (same version as `package.json`).
3. Attach platform installers plus `latest-mac.yml` / `latest-linux.yml` and `*.blockmap`.
4. Write early-adopter notes (unsigned macOS Gatekeeper steps; Linux preferred for smoother install) — mirror the CI body in the workflow.
5. **Publish** (undraft). Unsigned macOS is OK for the early-adopter path; do not wait on certs.

Linux-only public releases are acceptable if mac assets are unavailable for a given cut (document that in the release notes). Prefer shipping both platforms when CI matrix succeeds.

## Auto-update (electron-updater)

Packaged installs check GitHub Releases on **`getdevintern/devintern`** (see `electron-builder.yml` `publish.owner` / `publish.repo` and `package.json#repository`) on launch (after a short delay) and about every 6 hours, and **download updates automatically** when one is found. A banner surfaces when the update is ready to install (Restart & install / Later); a downloaded update is also applied on the next normal quit. About retains a lightweight manual **Check for updates** for power users; Settings has no Updates section. Dev / unpackaged builds no-op (`phase: disabled`) — no network calls, no error spam.

| Platform | Auto-update path | Gap / notes |
| -------- | ---------------- | ----------- |
| **macOS** | `.zip` (+ `latest-mac.yml`) | Works for discovery on the public feed even when unsigned. Gatekeeper may block applying an unsigned update — fall back to manual DMG/ZIP from the release. Production trust needs sign+notarize. |
| **Linux** | AppImage (+ `latest-linux.yml`) | Primary Linux auto-update path. `.deb` installs need a manual upgrade (or reinstall AppImage). |

Windows packaging / auto-update is out of scope for now.

Settings (`userData/settings.json`: last project, recent PM-ready projects, analytics opt-out, snooze) live **outside** the app bundle and survive updates. Choosing **Later** snoozes prompts for that version for 24 hours; a mid-agent-run restart asks for confirmation first.

**Signing vs public feed:** Packaging always emits update metadata (`latest-*.yml`, blockmaps) with or without certs. CI attaches those to the public draft whenever `PM_DESKTOP_PUBLIC_RELEASE_TOKEN` is set — unsigned macOS is an intentional early-adopter exception, not a blocked publish.

## What gets produced

| Platform | Typical files under `release/` |
| -------- | ------------------------------ |
| Linux    | `DevIntern-PM-<ver>-linux-*.AppImage`, `.deb`, `latest-linux.yml` |
| macOS    | `DevIntern-PM-<ver>-mac-<arch>.dmg`, `DevIntern-PM-<ver>-mac-<arch>.zip`, `latest-mac.yml`, `*.blockmap` |

All of the above work **without** signing secrets. Trust friction on macOS remains until Apple certs are enabled (below). `forceCodeSigning` stays `false` so unsigned scaffolds package. Windows packaging is out of scope for now.

## Smoke checks

Before treating a public release as live for dogfood:

1. **Linux install:** Download AppImage (or `.deb`) from the **published** `getdevintern/devintern` release → run / install → app launches.
2. **macOS install:** Download DMG from the same release → install → clear Gatekeeper / quarantine if needed (README / release notes) → app launches.
3. **Update discovery (when N+1 exists):**
   - Install packaged build **N** from a previous published release.
   - Publish **N+1** on the public repo (same feed).
   - Launch N → wait for background check or use About → **Check for updates** → status should show the newer version (download / ready-to-install depending on platform).
   - **Linux AppImage:** confirm Restart & install (or quit + relaunch) lands on N+1; Settings survive.
   - **Unsigned macOS:** if auto-apply is blocked by Gatekeeper, confirm manual download of N+1 from the release page still works and is documented in the release notes.

## CI secrets (placeholders)

Configure these on the repo / environment that runs `.github/workflows/pm-desktop-release.yml`. Builds skip signing/notarization when unset.

### Public update feed

| Secret | Purpose |
| ------ | ------- |
| `PM_DESKTOP_PUBLIC_RELEASE_TOKEN` | PAT with `contents:write` on `getdevintern/devintern`. **Required** for CI to open the public draft that electron-updater will read after you publish it. Independent of macOS CSC secrets. |

### Analytics (build-time)

| Secret | Maps to env |
| ------ | ----------- |
| `POSTHOG_API_KEY` | Baked into the main bundle via `electron.vite.config.ts` at package time. Missing → analytics permanently no-op in that build. |
| `POSTHOG_HOST` | Optional; defaults to `https://us.i.posthog.com` when unset. |

### macOS (Apple Developer) — optional for early adopters; required for production trust

| Secret | Maps to env |
| ------ | ----------- |
| `PM_DESKTOP_CSC_LINK` | `CSC_LINK` (base64 `.p12` of **Developer ID Application**) |
| `PM_DESKTOP_CSC_KEY_PASSWORD` | `CSC_KEY_PASSWORD` |
| `PM_DESKTOP_APPLE_ID` | `APPLE_ID` |
| `PM_DESKTOP_APPLE_APP_SPECIFIC_PASSWORD` | `APPLE_APP_SPECIFIC_PASSWORD` |
| `PM_DESKTOP_APPLE_TEAM_ID` | `APPLE_TEAM_ID` |

API-key notarization alternative: `PM_DESKTOP_APPLE_API_KEY_ID`, `PM_DESKTOP_APPLE_API_ISSUER`, and either `PM_DESKTOP_APPLE_API_KEY` (`.p8` body — materialized to a temp file at notarize time) or set `APPLE_API_KEY_FILE` to a path to the `.p8` on the runner. Notarization is skipped unless mac signing secrets (`PM_DESKTOP_CSC_*`) are also set.

### Linux

No signing secrets required.

## Blocked on certificates — enablement checklist

Complete in order once real certs exist. Split by platform so enablement can land in separate PRs. Until then, the [early-adopter public path](#early-adopter-public-releases-current-default) is the supported distribution model.

### macOS — sign + notarize (production trust)

1. [ ] Enroll in Apple Developer Program; create **Developer ID Application** certificate
2. [ ] Export `.p12` (or install in CI keychain); store as `PM_DESKTOP_CSC_LINK` + password
3. [ ] Create app-specific password or App Store Connect API key; set Team ID + notarization secrets
4. [ ] Confirm `build/entitlements.mac.plist` + hardened runtime still match shipping features
5. [ ] Set CI secrets; run a tagged build on `macos-latest`
6. [ ] Verify Gatekeeper: download the DMG on a clean Mac, open without `xattr` workarounds
7. [ ] (Optional) Set `forceCodeSigning: true` for mac-only release jobs so missing secrets fail loud
8. [ ] Soften or drop “unsigned” wording in the public release body once every published mac build is signed+notarized

### Linux

1. [ ] N/A for trust — AppImage / `.deb` already ship unsigned-usable
2. [ ] Optional later: `.rpm` (needs `rpmbuild` on the builder), Flathub, or distro package signing

### Early-adopter public multi-platform release (no Apple certs)

1. [ ] `PM_DESKTOP_PUBLIC_RELEASE_TOKEN` configured
2. [ ] Tag `pm-desktop-vX.Y.Z`; CI package matrix green (or local package + manual attach)
3. [ ] Public draft on `getdevintern/devintern` has Linux + macOS installers, `latest-mac.yml` / `latest-linux.yml`, blockmaps
4. [ ] Release notes set unsigned-macOS / early-adopter expectations
5. [ ] **Publish** the public release (not draft / not prerelease)
6. [ ] Smoke: install from public assets on each platform; optional N → N+1 update discovery check

### First production-quality public release (after certs)

1. [ ] macOS sign+notarize green (checklist above)
2. [ ] `PM_DESKTOP_PUBLIC_RELEASE_TOKEN` still configured; CI opens public draft
3. [ ] Linux + signed macOS artifacts on the same public GitHub Release
4. [ ] `latest-mac.yml` / `latest-linux.yml` attached and release **published** on `getdevintern/devintern`
5. [ ] Smoke: install N, publish N+1, confirm in-app update → download → restart keeps Settings (mac without Gatekeeper workarounds)
6. [ ] Release notes no longer claim unsigned macOS; download links ready for broader users

## Related

- Packaging scripts & env reference: [README.md](./README.md)
- Config: `electron-builder.yml`, `build/notarize.cjs`, `scripts/signing-env.ts`
- Workflow: `../../.github/workflows/pm-desktop-release.yml`
- Source sync (not this feed): `publish/PUBLISHING.md`
