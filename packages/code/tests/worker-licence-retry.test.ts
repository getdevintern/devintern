/**
 * A signed-in worker licence denial stays retryable for the worker service
 * even when the server reason quoted in the message contains wording that
 * `isPermanentLicenseDenial` treats as permanent.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let authenticated = true;
// Keep the real exports: other test files in this process import them.
const realAuth = await import("@devintern/auth");
mock.module("@devintern/auth", () => ({
  ...realAuth,
  getAuthenticatedUser: async () =>
    authenticated
      ? {
          id: "user-1",
          email: "test@example.com",
          createdAt: new Date().toISOString(),
          accessToken: "test-access-token",
        }
      : null,
}));

const { LicenseCheckError, checkLicense, requireLicense } =
  await import("@devintern/license-check");
const { isPermanentLicenseDenial } = await import("../src/lib/worker/startup");

const originalFetch = globalThis.fetch;

function supabaseConfig() {
  const dir = mkdtempSync(join(tmpdir(), "worker-licence-retry-"));
  return {
    url: "https://x.supabase.co",
    publishableKey: "pk",
    sessionFilePath: join(dir, "s.json"),
  };
}

const worker = {
  productKey: "devintern/code",
  requireAutomation: true,
  allowTrial: true,
  loginCommand: "devintern worker login",
  retryBaseDelayMs: 1,
};

beforeEach(() => {
  authenticated = true;
  process.env.DEVINTERN_SKIP_LICENSE_CHECK = "0";
  delete process.env.LICENSE_KEY;
  process.env.DEVINTERN_API_BASE = "https://license.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.DEVINTERN_API_BASE;
});

/** Both worker exit paths: the result (cli.ts exitOnLicenseDenial) and the thrown error (exitOnStartupError). */
function permanentOnBothPaths(result: Awaited<ReturnType<typeof checkLicense>>): boolean[] {
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  let thrown: unknown;
  try {
    requireLicense(result);
  } catch (error) {
    thrown = error;
  }
  errorSpy.mockRestore();
  if (!(thrown instanceof LicenseCheckError)) throw new Error("expected LicenseCheckError");
  return [
    isPermanentLicenseDenial(result),
    isPermanentLicenseDenial({
      valid: false,
      message: thrown.message,
      retryable: thrown.retryable,
    }),
  ];
}

describe("worker licence denial retry decision", () => {
  test.each([
    "requires an automation license",
    "has no matching license",
    "already used",
    "License key is invalid or revoked",
  ])("entitled:false with reason %p stays retryable", async (reason) => {
    globalThis.fetch = (async () =>
      Response.json({ entitled: false, reason })) as unknown as typeof fetch;
    const result = await checkLicense({ ...worker, supabaseConfig: supabaseConfig() });
    expect(result.valid).toBe(false);
    expect(result.message).toContain(reason);
    expect(permanentOnBothPaths(result)).toEqual([false, false]);
  });

  test("HTTP 401 with 'user not signed in' stays retryable", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ reason: "user not signed in" }), {
        status: 401,
      })) as unknown as typeof fetch;
    const result = await checkLicense({ ...worker, supabaseConfig: supabaseConfig() });
    expect(result.message).toContain("user not signed in");
    expect(permanentOnBothPaths(result)).toEqual([false, false]);
  });

  test("never signed in stays permanent", async () => {
    authenticated = false;
    const result = await checkLicense({ ...worker, supabaseConfig: supabaseConfig() });
    expect(result.retryable).toBeUndefined();
    expect(isPermanentLicenseDenial(result)).toBe(true);
  });
});
