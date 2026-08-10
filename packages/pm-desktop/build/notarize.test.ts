/**
 * Tests for the notarize gate (no network).
 * Covers skip paths, signing-credential guard, and API-key temp-file materialization.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ENV_KEYS = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_FILE",
  "CSC_LINK",
  "CSC_NAME",
  "CSC_IDENTITY",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const previous: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
  }
  return previous;
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearNotarizeEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function loadNotarizeModule() {
  // Reload so dynamic import picks up mock.module between tests when needed.
  delete require.cache[require.resolve("./notarize.cjs")];
  return require("./notarize.cjs") as {
    default: (context: Record<string, unknown>) => Promise<void>;
    hasMacSigningCredentials: () => boolean;
    hasAppleNotarizeCreds: () => boolean;
    resolveAppleApiKeyPath: () => { appleApiKey: string; cleanup: (() => void) | null };
  };
}

describe("notarize hook gate", () => {
  afterEach(() => {
    mock.restore();
  });

  test("skips non-darwin platforms", async () => {
    const { default: notarizeHook } = loadNotarizeModule();
    await expect(
      notarizeHook({
        electronPlatformName: "linux",
        appOutDir: "/tmp",
        packager: { appInfo: { productFilename: "DevIntern PM" } },
      }),
    ).resolves.toBeUndefined();
  });

  test("skips darwin when Apple credentials are absent", async () => {
    const previous = snapshotEnv();
    try {
      clearNotarizeEnv();
      const { default: notarizeHook } = loadNotarizeModule();
      await expect(
        notarizeHook({
          electronPlatformName: "darwin",
          appOutDir: "/tmp",
          packager: { appInfo: { productFilename: "DevIntern PM" } },
        }),
      ).resolves.toBeUndefined();
    } finally {
      restoreEnv(previous);
    }
  });

  test("skips when Apple creds exist but mac signing credentials do not", async () => {
    const previous = snapshotEnv();
    const notarizeMock = mock(() => Promise.resolve());
    mock.module("@electron/notarize", () => ({ notarize: notarizeMock }));

    try {
      clearNotarizeEnv();
      process.env.APPLE_API_KEY_ID = "KEYID12345";
      process.env.APPLE_API_ISSUER = "issuer-uuid";
      process.env.APPLE_API_KEY = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----";

      const { default: notarizeHook, hasMacSigningCredentials } = loadNotarizeModule();
      expect(hasMacSigningCredentials()).toBe(false);

      await expect(
        notarizeHook({
          electronPlatformName: "darwin",
          appOutDir: "/tmp",
          packager: { appInfo: { productFilename: "DevIntern PM" } },
        }),
      ).resolves.toBeUndefined();

      expect(notarizeMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv(previous);
    }
  });

  test("resolveAppleApiKeyPath materializes APPLE_API_KEY body to a temp .p8", () => {
    const previous = snapshotEnv();
    try {
      clearNotarizeEnv();
      process.env.APPLE_API_KEY_ID = "KEYID12345";
      const body = "-----BEGIN PRIVATE KEY-----\nfake-key-body\n-----END PRIVATE KEY-----";
      process.env.APPLE_API_KEY = body;

      const { resolveAppleApiKeyPath } = loadNotarizeModule();
      const { appleApiKey, cleanup } = resolveAppleApiKeyPath();
      try {
        expect(appleApiKey.endsWith(".p8")).toBe(true);
        expect(readFileSync(appleApiKey, "utf8")).toBe(`${body}\n`);
      } finally {
        cleanup?.();
      }
    } finally {
      restoreEnv(previous);
    }
  });

  test("resolveAppleApiKeyPath prefers APPLE_API_KEY_FILE path", () => {
    const previous = snapshotEnv();
    const dir = mkdtempSync(join(tmpdir(), "notarize-key-"));
    const keyPath = join(dir, "AuthKey_FILE.p8");
    writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nfile\n-----END PRIVATE KEY-----\n");

    try {
      clearNotarizeEnv();
      process.env.APPLE_API_KEY_ID = "KEYID12345";
      process.env.APPLE_API_KEY_FILE = keyPath;
      process.env.APPLE_API_KEY = "should-not-use-body";

      const { resolveAppleApiKeyPath } = loadNotarizeModule();
      const { appleApiKey, cleanup } = resolveAppleApiKeyPath();
      expect(appleApiKey).toBe(keyPath);
      expect(cleanup).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(previous);
    }
  });

  test("calls notarize with materialized API key path when signing creds are present", async () => {
    const previous = snapshotEnv();
    const notarizeMock = mock(() => Promise.resolve());
    mock.module("@electron/notarize", () => ({ notarize: notarizeMock }));

    const outDir = mkdtempSync(join(tmpdir(), "notarize-app-"));
    const appName = "DevIntern PM";
    mkdirSync(join(outDir, `${appName}.app`));

    try {
      clearNotarizeEnv();
      process.env.CSC_LINK = "file:///certs/mac.p12";
      process.env.APPLE_API_KEY_ID = "KEYID12345";
      process.env.APPLE_API_ISSUER = "issuer-uuid";
      const body = "-----BEGIN PRIVATE KEY-----\nci-secret-body\n-----END PRIVATE KEY-----";
      process.env.APPLE_API_KEY = body;

      const { default: notarizeHook } = loadNotarizeModule();
      await notarizeHook({
        electronPlatformName: "darwin",
        appOutDir: outDir,
        packager: { appInfo: { productFilename: appName } },
      });

      expect(notarizeMock).toHaveBeenCalledTimes(1);
      const args = notarizeMock.mock.calls[0]?.[0] as {
        appPath: string;
        appleApiKey: string;
        appleApiKeyId: string;
        appleApiIssuer: string;
      };
      expect(args.appPath).toBe(join(outDir, `${appName}.app`));
      expect(args.appleApiKeyId).toBe("KEYID12345");
      expect(args.appleApiIssuer).toBe("issuer-uuid");
      expect(args.appleApiKey.endsWith(".p8")).toBe(true);
      // Temp file is cleaned up after notarize returns.
      expect(() => readFileSync(args.appleApiKey)).toThrow();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      restoreEnv(previous);
    }
  });
});
