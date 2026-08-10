# pm-desktop releases

Versioned process for cutting installable `@devintern/pm-desktop` builds for macOS and Linux, including the public auto-update feed.

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
   - Creates a **private staging draft** on the repo that ran the workflow (typically this private monorepo). That draft is for humans to inspect — it is **not** the electron-updater feed.
   - **If and only if** `PM_DESKTOP_PUBLIC_RELEASE_TOKEN` (PAT with `contents:write` on `getdevintern/devintern`) **and** macOS signing secrets (`PM_DESKTOP_CSC_LINK`) are set, CI also opens a **draft** release on the public update-feed repo `getdevintern/devintern` with the same tag and artifacts.
   - Without that PAT + signing gate, tagging private `pm-desktop-v*` alone does **not** make packaged apps see an update.
6. **Smoke-test** one artifact per platform before going live.
7. **Publish the public feed** (undraft the release on `getdevintern/devintern`):
   - Open https://github.com/getdevintern/devintern/releases
   - Find the matching `pm-desktop-v*` **draft**, verify artifacts + yml/blockmap files, then **Publish release** (not prerelease).
   - Draft and prerelease tags are invisible to `electron-updater`'s "latest" channel.
   - The private monorepo draft can stay draft or be discarded; clients never read it.

### Manual public-feed handoff (when CI skips the public draft)

If signing secrets or `PM_DESKTOP_PUBLIC_RELEASE_TOKEN` were missing:

1. Download the private staging draft assets (or local `packages/pm-desktop/release/` outputs).
2. Create a release on `getdevintern/devintern` with tag `pm-desktop-vX.Y.Z` (same version as `package.json`).
3. Attach platform installers plus `latest-mac.yml` / `latest-linux.yml` and `*.blockmap`.
4. Publish (undraft) only after macOS builds are signed (see signing gate below).

## Auto-update (electron-updater)

Packaged installs check GitHub Releases on **`getdevintern/devintern`** (see `electron-builder.yml` `publish.owner` / `publish.repo` and `package.json#repository`) on launch (after a short delay) and about every 6 hours. Users can also check from **Settings** or **About**. Dev / unpackaged builds no-op (`phase: disabled`) — no network calls, no error spam.

| Platform | Auto-update path | Gap / notes |
| -------- | ---------------- | ----------- |
| **macOS** | `.zip` (+ `latest-mac.yml`) | Primary ship path once signed+notarized. DMG is for manual install only. |
| **Linux** | AppImage (+ `latest-linux.yml`) | Primary Linux auto-update path. `.deb` installs need a manual upgrade (or reinstall AppImage). |

Windows packaging / auto-update is out of scope for now.

Settings (`userData/settings.json`: last project, recent PM-ready projects, analytics opt-out, snooze) live **outside** the app bundle and survive updates. Choosing **Later** snoozes prompts for that version for 24 hours; a mid-agent-run restart asks for confirmation first.

**Signing:** Production auto-update on macOS expects signed+notarized builds (Gatekeeper). Unsigned CI artifacts still generate update metadata for internal testing on the **private** draft only. CI will not attach unsigned mac builds to the public `getdevintern/devintern` feed.

## What gets produced

| Platform | Typical files under `release/` |
| -------- | ------------------------------ |
| Linux    | `DevIntern-PM-<ver>-linux-*.AppImage`, `.deb`, `latest-linux.yml` |
| macOS    | `DevIntern-PM-<ver>-mac-<arch>.dmg`, `.zip`, `latest-mac.yml`, `*.blockmap` |

All of the above work **without** signing secrets. Trust friction on macOS remains until Apple certs are enabled (below). `forceCodeSigning` stays `false` so unsigned scaffolds package; the **public feed publish** is what is gated on signing secrets. Windows packaging is out of scope for now.

## CI secrets (placeholders)

Configure these on the repo / environment that runs `.github/workflows/pm-desktop-release.yml`. Builds skip signing/notarization when unset.

### Public update feed

| Secret | Purpose |
| ------ | ------- |
| `PM_DESKTOP_PUBLIC_RELEASE_TOKEN` | PAT with `contents:write` on `getdevintern/devintern`. Required to open the public draft release that electron-updater reads. |

### Analytics (build-time)

| Secret | Maps to env |
| ------ | ----------- |
| `POSTHOG_API_KEY` | Baked into the main bundle via `electron.vite.config.ts` at package time. Missing → analytics permanently no-op in that build. |
| `POSTHOG_HOST` | Optional; defaults to `https://us.i.posthog.com` when unset. |

### macOS (Apple Developer)

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

Complete in order once real certs exist. Split by platform so enablement can land in separate PRs.

### macOS — sign + notarize

1. [ ] Enroll in Apple Developer Program; create **Developer ID Application** certificate
2. [ ] Export `.p12` (or install in CI keychain); store as `PM_DESKTOP_CSC_LINK` + password
3. [ ] Create app-specific password or App Store Connect API key; set Team ID + notarization secrets
4. [ ] Confirm `build/entitlements.mac.plist` + hardened runtime still match shipping features
5. [ ] Set CI secrets; run a tagged build on `macos-latest`
6. [ ] Verify Gatekeeper: download the DMG on a clean Mac, open without `xattr` workarounds
7. [ ] (Optional) Set `forceCodeSigning: true` for mac-only release jobs so missing secrets fail loud

### Linux

1. [ ] N/A for trust — AppImage / `.deb` already ship unsigned-usable
2. [ ] Optional later: `.rpm` (needs `rpmbuild` on the builder), Flathub, or distro package signing

### First public multi-platform release

1. [ ] macOS sign+notarize green
2. [ ] `PM_DESKTOP_PUBLIC_RELEASE_TOKEN` configured; CI opens public draft on `getdevintern/devintern`
3. [ ] Linux artifacts attached on the same public GitHub Release
4. [ ] `latest-mac.yml` / `latest-linux.yml` attached and release **published** (not draft) on `getdevintern/devintern`
5. [ ] Smoke: install N, publish N+1, confirm in-app update → download → restart keeps Settings
6. [ ] Release notes + download links published for end users

## Related

- Packaging scripts & env reference: [README.md](./README.md)
- Config: `electron-builder.yml`, `build/notarize.cjs`, `scripts/signing-env.ts`
- Workflow: `../../.github/workflows/pm-desktop-release.yml`
