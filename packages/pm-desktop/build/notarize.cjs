/**
 * macOS notarization hook for electron-builder.
 *
 * Runs only when both Apple notarization credentials and macOS signing
 * credentials are present. Without them the hook exits cleanly so local and CI
 * packaging never hard-fail on missing certs.
 *
 * Supported credential sets (set via CI secrets / local env):
 *   1) Apple ID: APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 *   2) App Store Connect API key: APPLE_API_KEY_ID + APPLE_API_ISSUER +
 *      APPLE_API_KEY_FILE (path to .p8) or APPLE_API_KEY (.p8 body — written to a
 *      temp file because @electron/notarize requires a filesystem path)
 *
 * Notarization also requires mac signing material (CSC_LINK / CSC_NAME /
 * CSC_IDENTITY) — notarytool rejects unsigned apps.
 */

const { existsSync, writeFileSync, unlinkSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function isSet(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasAppleIdCreds() {
  return Boolean(
    isSet(process.env.APPLE_ID) &&
    isSet(process.env.APPLE_APP_SPECIFIC_PASSWORD) &&
    isSet(process.env.APPLE_TEAM_ID),
  );
}

function hasApiKeyCreds() {
  return Boolean(
    isSet(process.env.APPLE_API_KEY_ID) &&
    isSet(process.env.APPLE_API_ISSUER) &&
    (isSet(process.env.APPLE_API_KEY) || isSet(process.env.APPLE_API_KEY_FILE)),
  );
}

function hasAppleNotarizeCreds() {
  return hasAppleIdCreds() || hasApiKeyCreds();
}

/** True when macOS code-signing material is available (required before notarize). */
function hasMacSigningCredentials() {
  return (
    isSet(process.env.CSC_LINK) || isSet(process.env.CSC_NAME) || isSet(process.env.CSC_IDENTITY)
  );
}

/**
 * Resolve a filesystem path to the .p8 for @electron/notarize.
 * Prefers APPLE_API_KEY_FILE; otherwise materializes APPLE_API_KEY body to a temp file.
 *
 * @returns {{ appleApiKey: string, cleanup: (() => void) | null }}
 */
function resolveAppleApiKeyPath() {
  if (isSet(process.env.APPLE_API_KEY_FILE)) {
    return { appleApiKey: process.env.APPLE_API_KEY_FILE.trim(), cleanup: null };
  }

  const body = process.env.APPLE_API_KEY;
  if (!isSet(body)) {
    throw new Error(
      "[notarize] APPLE_API_KEY_FILE or APPLE_API_KEY is required for API-key notarization.",
    );
  }

  const trimmed = body.trim();
  // Allow a path stuffed into APPLE_API_KEY when the file already exists on disk.
  if (existsSync(trimmed) && !trimmed.includes("-----BEGIN")) {
    return { appleApiKey: trimmed, cleanup: null };
  }

  const keyId = isSet(process.env.APPLE_API_KEY_ID) ? process.env.APPLE_API_KEY_ID.trim() : "tmp";
  const tmpPath = path.join(os.tmpdir(), `AuthKey_${keyId}_${process.pid}.p8`);
  writeFileSync(tmpPath, trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    appleApiKey: tmpPath,
    cleanup: () => {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup
      }
    },
  };
}

/** @param {import('electron-builder').AfterPackContext} context */
async function notarizeHook(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  if (!hasAppleNotarizeCreds()) {
    console.log(
      "[notarize] Skipping — set APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID " +
        "or APPLE_API_KEY_ID/APPLE_API_ISSUER/(APPLE_API_KEY_FILE|APPLE_API_KEY) to enable.",
    );
    return;
  }

  if (!hasMacSigningCredentials()) {
    console.warn(
      "[notarize] Skipping — Apple notarization credentials are set but macOS signing " +
        "credentials are missing (CSC_LINK, CSC_NAME, or CSC_IDENTITY). Sign the app first.",
    );
    return;
  }

  // Dynamic import so installs without @electron/notarize still package unsigned.
  let notarize;
  try {
    ({ notarize } = await import("@electron/notarize"));
  } catch {
    console.warn(
      "[notarize] @electron/notarize is not installed; skipping notarization. " +
        "Add it as a devDependency when enabling signed macOS releases.",
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!existsSync(appPath)) {
    throw new Error(`[notarize] App not found at ${appPath}`);
  }

  console.log(`[notarize] Submitting ${appPath}…`);

  let cleanup = null;
  try {
    if (hasApiKeyCreds()) {
      const resolved = resolveAppleApiKeyPath();
      cleanup = resolved.cleanup;
      await notarize({
        appPath,
        appleApiKey: resolved.appleApiKey,
        appleApiKeyId: process.env.APPLE_API_KEY_ID,
        appleApiIssuer: process.env.APPLE_API_ISSUER,
      });
    } else {
      await notarize({
        appPath,
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      });
    }
  } finally {
    if (cleanup) cleanup();
  }

  console.log("[notarize] Done.");
}

exports.default = notarizeHook;
exports.hasMacSigningCredentials = hasMacSigningCredentials;
exports.hasAppleNotarizeCreds = hasAppleNotarizeCreds;
exports.resolveAppleApiKeyPath = resolveAppleApiKeyPath;
