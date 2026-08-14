# pm-desktop releases

Versioned process for cutting installable `@devintern/pm-desktop` builds for macOS and Linux, including the public auto-update feed.

Product source and the binary update feed are both maintained in `getdevintern/devintern`. Installable releases remain separate from npm package publishing.

## Public releases

Public macOS artifacts are Developer ID signed and notarized. The release job verifies the signature, stapled notarization ticket, and Gatekeeper acceptance for both Apple silicon and Intel before it uploads artifacts.

| Expectation     | Detail                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Linux**       | AppImage / `.deb`; platform signing is not required                                                                                                                                     |
| **macOS**       | Signed and notarized DMG / ZIP for a Gatekeeper-verified install                                                                                                                        |
| **Update feed** | Same public release assets include `latest-mac.yml` / `latest-linux.yml` + blockmaps so packaged installs can discover updates once the release is **published** (not draft/prerelease) |

Local packaging can still run without Apple credentials for contributor testing, but those unsigned artifacts are not public releases.

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
   - Creates a draft GitHub Release in this repository for inspection before publishing.
   - The macOS job requires signing and notarization credentials, then verifies both app bundles with `codesign`, `stapler`, and `spctl`.
6. **Smoke-test** one artifact per platform before going live (see [Smoke checks](#smoke-checks)).
7. **Publish the public feed** (undraft the release on `getdevintern/devintern`):
   - Open https://github.com/getdevintern/devintern/releases
   - Find the matching `pm-desktop-v*` **draft**, verify artifacts + yml/blockmap files, then **Publish release** (not prerelease).
   - Draft and prerelease tags are invisible to `electron-updater`'s "latest" channel.
   - Confirm the release body identifies the macOS artifacts as Developer ID signed and notarized.

## Auto-update (electron-updater)

Packaged installs check GitHub Releases on **`getdevintern/devintern`** (see `electron-builder.yml` `publish.owner` / `publish.repo` and `package.json#repository`) on launch (after a short delay) and about every 6 hours, and **download updates automatically** when one is found. A banner surfaces when the update is ready to install (Restart & install / Later); a downloaded update is also applied on the next normal quit. About retains a lightweight manual **Check for updates** for power users; Settings has no Updates section. Dev / unpackaged builds no-op (`phase: disabled`) — no network calls, no error spam.

| Platform  | Auto-update path                | Gap / notes                                                                                    |
| --------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| **macOS** | `.zip` (+ `latest-mac.yml`)     | Signed and notarized update path; DMG is the manual-install fallback.                          |
| **Linux** | AppImage (+ `latest-linux.yml`) | Primary Linux auto-update path. `.deb` installs need a manual upgrade (or reinstall AppImage). |

Windows packaging / auto-update is out of scope for now.

Settings (`userData/settings.json`: last project, recent PM-ready projects, analytics opt-out, snooze) live **outside** the app bundle and survive updates. Choosing **Later** snoozes prompts for that version for 24 hours; a mid-agent-run restart asks for confirmation first.

**Signing vs public feed:** Local packaging can emit update metadata without certificates, but release CI requires and verifies macOS signing/notarization before creating the public draft.

## What gets produced

| Platform | Typical files under `release/`                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------- |
| Linux    | `DevIntern-PM-<ver>-linux-*.AppImage`, `.deb`, `latest-linux.yml`                                        |
| macOS    | `DevIntern-PM-<ver>-mac-<arch>.dmg`, `DevIntern-PM-<ver>-mac-<arch>.zip`, `latest-mac.yml`, `*.blockmap` |

Local builds work without signing secrets. Release CI fails closed when macOS signing or notarization credentials are missing. Windows packaging is out of scope for now.

## Smoke checks

Before publishing a public release:

1. **Linux install:** Download AppImage (or `.deb`) from the **published** `getdevintern/devintern` release → run / install → app launches.
2. **macOS install:** Download the DMG from the same release → install → confirm it opens normally under Gatekeeper → app launches.
3. **Update discovery (when N+1 exists):**
   - Install packaged build **N** from a previous published release.
   - Publish **N+1** on the public repo (same feed).
   - Launch N → wait for background check or use About → **Check for updates** → status should show the newer version (download / ready-to-install depending on platform).
   - **Linux AppImage:** confirm Restart & install (or quit + relaunch) lands on N+1; Settings survive.
   - **macOS:** confirm Restart & install (or quit + relaunch) lands on N+1 and Settings survive.
   - **First release named `DevIntern PM.app`:** start from 0.9.8, then confirm the updater replaces `DevIntern-PM.app`, launches the spaced bundle name, and does not leave a duplicate app in `/Applications`.

## CI configuration

Configure these on the repo / environment that runs `.github/workflows/pm-desktop-release.yml`. Build-time values are compiled into the distributed application and are not confidential. The release workflow fails when signing/notarization credentials are incomplete.

### Analytics (build-time)

| Repository setting | Kind             | Maps to env                                                                                                                                                                             |
| ------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTHOG_API_KEY`  | Actions secret   | Baked into the main bundle via `electron.vite.config.ts` at package time. Use the PostHog project API key, not a personal API key. Missing → analytics permanently no-op in that build. |
| `POSTHOG_HOST`     | Actions variable | Optional; defaults to `https://us.i.posthog.com` when unset. The existing Actions secret remains a compatibility fallback.                                                              |

### GitHub OAuth (build-time)

| Repository setting                  | Kind             | Maps to env                                                                                                                                                                                                      |
| ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PM_DESKTOP_GITHUB_OAUTH_CLIENT_ID` | Actions variable | Maps to `GITHUB_OAUTH_CLIENT_ID`, the public GitHub App client ID baked into the main bundle. Missing → GitHub OAuth sign-in is hidden; PAT sign-in remains available. Do not configure or ship a client secret. |

### macOS (Apple Developer) — required

| Secret                                   | Maps to env                                                |
| ---------------------------------------- | ---------------------------------------------------------- |
| `PM_DESKTOP_CSC_LINK`                    | `CSC_LINK` (base64 `.p12` of **Developer ID Application**) |
| `PM_DESKTOP_CSC_KEY_PASSWORD`            | `CSC_KEY_PASSWORD`                                         |
| `PM_DESKTOP_APPLE_ID`                    | `APPLE_ID`                                                 |
| `PM_DESKTOP_APPLE_APP_SPECIFIC_PASSWORD` | `APPLE_APP_SPECIFIC_PASSWORD`                              |
| `PM_DESKTOP_APPLE_TEAM_ID`               | `APPLE_TEAM_ID`                                            |

API-key notarization alternative: `PM_DESKTOP_APPLE_API_KEY_ID`, `PM_DESKTOP_APPLE_API_ISSUER`, and either `PM_DESKTOP_APPLE_API_KEY` (`.p8` body — materialized to a temp file at notarize time) or set `APPLE_API_KEY_FILE` to a path to the `.p8` on the runner. Notarization is skipped unless mac signing secrets (`PM_DESKTOP_CSC_*`) are also set.

### Linux

No signing secrets required.

## Release readiness checklist

1. [ ] All macOS signing/notarization secrets are configured
2. [ ] Tag `pm-desktop-vX.Y.Z`; CI package matrix is green
3. [ ] CI verifies both macOS architectures with `codesign`, `stapler`, and `spctl`
4. [ ] Public draft has Linux + macOS installers, `latest-mac.yml` / `latest-linux.yml`, and blockmaps
5. [ ] Smoke-test fresh installs from the draft assets
6. [ ] **Publish** the public release (not draft / not prerelease)
7. [ ] For N+1, confirm in-app update → download → restart keeps Settings

## Related

- Packaging scripts & env reference: [README.md](./README.md)
- Config: `electron-builder.yml`, `build/notarize.cjs`, `scripts/signing-env.ts`
- Workflow: `../../.github/workflows/pm-desktop-release.yml`
