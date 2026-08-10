# @devintern/pm-desktop

Electron desktop app for `@getdevintern/pm`: multi-ticket AI task creation for your tracker.

## Develop

```bash
bun install          # from monorepo root
bun run dev          # electron-vite dev
bun run build        # compile only → out/
bun run test
```

## Package (installable artifacts)

Packaging uses [electron-builder](https://www.electron.build/). Scripts compile with electron-vite, then produce platform installers under `release/`.

```bash
# Current host OS (recommended for local smoke tests)
bun run package

# Explicit targets (must run on a matching OS / CI runner in practice)
bun run package:linux   # AppImage, .deb
bun run package:mac     # .dmg + .zip (macOS runner only)
bun run package:dir     # unpacked app dir only (fast smoke)
```

**Unsigned by default.** Signing and notarization are configured but gated on env vars (see below). Local and CI builds without secrets succeed and emit unsigned artifacts.

| Platform | Artifacts | Signing today |
| -------- | --------- | ------------- |
| Linux    | AppImage, `.deb` | Not required (`rpm` optional if `rpmbuild` is installed) |
| macOS    | `.dmg`, `.zip` | Blocked on Apple Developer certs → Gatekeeper / quarantine friction |

Windows packaging is intentionally out of scope for now.

### macOS: open unsigned builds locally

Until notarization lands, users may need System Settings → Privacy & Security → Open Anyway, or:

```bash
xattr -dr com.apple.quarantine "/path/to/DevIntern PM.app"
```

## Signing & notarization env vars

Never commit certificates. Inject via CI secrets or a local (gitignored) env.

### Shared / code signing (`electron-builder`)

| Variable | Purpose |
| -------- | ------- |
| `CSC_LINK` | Path, `file://` URL, HTTPS URL, or base64 of a `.p12` |
| `CSC_KEY_PASSWORD` | Password for `CSC_LINK` |
| `CSC_NAME` | macOS keychain identity name (alternative to `CSC_LINK`) |
| `CSC_IDENTITY_AUTO_DISCOVERY` | Set automatically to `false` when no certs; do not force `true` without a cert |

### macOS notarization (afterSign hook)

| Variable | Purpose |
| -------- | ------- |
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | 10-character Team ID |
| *or* `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` + `APPLE_API_KEY_FILE` | App Store Connect API key (preferred: filesystem path to `.p8`) |
| `APPLE_API_KEY` | Optional alternative: raw `.p8` body. The hook writes it to a temp file because `@electron/notarize` requires a path |

Hardened runtime + entitlements live in `build/entitlements.mac.plist` (`allow-jit` only). The notarize hook (`build/notarize.cjs`) no-ops when Apple credentials **or** mac signing credentials (`CSC_LINK` / `CSC_NAME` / `CSC_IDENTITY`) are missing — notarization requires a signed app.

When credentials are absent, `scripts/signing-env.ts` forces `CSC_IDENTITY_AUTO_DISCOVERY=false` so packaging never fails looking for a local identity.

## Release process

See [RELEASE.md](./RELEASE.md) for the versioned cut → package → attach workflow, auto-update feed requirements, platform coverage, and the certificate enablement checklist.

## Auto-update (packaged builds)

`electron-updater` checks the GitHub Releases feed configured via `electron-builder.yml` `publish` + `package.json#repository`. Unpackaged `bun run dev` builds disable checks. In the app: Settings → **Check for updates**, or About → **Check for updates**. When an update is ready, a banner offers **Download & install** / **Restart & install** or **Later**.

## Connect GitHub (managed clones)

Primary path: **Connect GitHub repository** (Welcome or project menu) → **Sign in with GitHub** (OAuth device flow via the DevIntern PM GitHub App) → paste or pick `owner/repo` (branch optional). The app clones into a managed directory under app data (`userData/projects/<owner>-<repo>-<id>/`), then runs the existing PM setup wizard against that checkout. Sidebar identity is a binding `{ remote, localPath, lastFetch, managed }`. One managed clone per GitHub remote; reconnect reuses it, and a missing directory is re-cloned. **Open existing folder** remains as an advanced eng path and is never silently migrated into managed storage.

Auth defaults to **Sign in with GitHub** (short-lived, refreshable user access token from the DevIntern PM GitHub App; no secret shipped in the app). A **personal access token** remains as an advanced fallback ("Use a personal access token instead") for power users and CI-like setups. Public repos can be connected without any sign-in. Tokens are stored under userData (encrypted with Electron `safeStorage` when available). Settings shows the connection method, **Disconnect GitHub**, the on-disk path, **Reveal in file manager**, and **Remove project** (managed clones delete the checkout after confirm).

The GitHub App Client ID is baked into the main bundle at build time via `GITHUB_OAUTH_CLIENT_ID` (see `.env.example`). When unset, the "Sign in with GitHub" button is hidden and only the PAT path is offered.

## Project git sync

On open (and via **Get updates** in the project bar), the app resolves the git root, `git fetch`es, then `merge --ff-only` onto the upstream tip when the tree is clean or only **PM soft-dirty** (modified/untracked **repo-root** `.gitignore` from pm init). Soft-dirty is silent in the project bar (not “Local edits”). Paths under `.devintern-pm/` (secrets, markdown tasks, etc.) and other ignored files do not count as dirtiness. Nested `.gitignore` edits are hard-dirty. Hard-dirty trees skip applying updates with a clear message — PM does not stash, reset, or non-ff merge. Soft-dirty does not block Get updates for gating — but if both local and remote changed the same soft-dirty file (commonly `.gitignore`), git can still refuse the merge with “would be overwritten”; ask eng to commit or reconcile, then retry. Managed clones reuse the same fetch helper. Git network ops share a single end-to-end timeout so a hung remote cannot block project open indefinitely; when a GitHub PAT is stored it is injected for network commands via `http.extraHeader`.

## Layout

- `src/main` — Electron main process
- `src/preload` — preload bridge
- `src/renderer` — React UI
- `out/` — electron-vite compile output (not committed)
- `release/` — electron-builder artifacts (not committed)
- `build/` — entitlements, notarize hook, optional icons (`icon.icns` / `icon.png`)
- `electron-builder.yml` — packaging targets and gated signing config
