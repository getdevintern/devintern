import { afterEach, beforeEach, describe, expect, mock, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKER_PILOT_DOCS_URL,
  activateWorkerTrial,
  checkLicense,
  resolveApiBase,
  setReleaseBuildForTests,
  shouldSkipLicenseCheck,
  workerPilotSignInMessage,
} from "../src/index.ts";

const originalFetch = globalThis.fetch;
let authenticated = true;

mock.module("@devintern/auth", () => ({
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

function freshSupabaseConfig() {
  const dir = mkdtempSync(join(tmpdir(), "license-check-test-"));
  return {
    url: "https://x.supabase.co",
    publishableKey: "pk",
    sessionFilePath: join(dir, "session.json"),
  };
}

describe("checkLicense entitlement API", () => {
  beforeEach(() => {
    authenticated = true;
    process.env.DEVINTERN_SKIP_LICENSE_CHECK = "0";
    delete process.env.LICENSE_KEY;
    process.env.DEVINTERN_API_BASE = "https://license.test";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.DEVINTERN_API_BASE;
    mock.restore();
  });

  test("retries transient HTTP errors then confirms entitlement", async () => {
    let calls = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (!url.includes("/api/license/check")) {
        return originalFetch(input);
      }

      calls += 1;
      if (calls < 3) {
        return new Response(JSON.stringify({ reason: "polar customer lookup failed" }), {
          status: 502,
        });
      }
      return Response.json({
        entitled: true,
        source: "team-automation",
        productName: "DevIntern Team",
      });
    }) as typeof fetch;

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const { checkLicense } = await import(`../src/index.ts?retry=${Date.now()}`);

    const result = await checkLicense({
      productKey: "devintern/code",
      retryBaseDelayMs: 1,
      supabaseConfig: freshSupabaseConfig(),
    });

    expect(calls).toBe(3);
    expect(result.valid).toBe(true);
    expect(result.source).toBe("entitlement");
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("License entitlement check failed"),
      ),
    ).toBe(false);

    warnSpy.mockRestore();
  });

  test("fails when entitlement check keeps failing and no cache exists", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (!url.includes("/api/license/check")) {
        return originalFetch(input);
      }
      return new Response(JSON.stringify({ reason: "polar license lookup failed" }), {
        status: 502,
      });
    }) as typeof fetch;

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const { checkLicense } = await import(`../src/index.ts?nocache=${Date.now()}`);

    const result = await checkLicense({
      productKey: "devintern/code",
      retryBaseDelayMs: 1,
      supabaseConfig: freshSupabaseConfig(),
      requireAutomation: true,
    });

    expect(result.valid).toBe(false);
    expect(result.source).toBe("none");
    expect(result.message).toContain("HTTP 502: polar license lookup failed");
    const entitlementFailureWarn = warnSpy.mock.calls.find((call) =>
      String(call[0]).includes("License entitlement check failed"),
    );
    expect(entitlementFailureWarn).toBeDefined();
    expect(String(entitlementFailureWarn?.[0])).toContain("3 attempts");

    warnSpy.mockRestore();
  });

  test("honors the grace window when the server becomes unreachable after a successful check", async () => {
    const supabaseConfig = freshSupabaseConfig();
    let failing = false;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (!url.includes("/api/license/check")) {
        return originalFetch(input);
      }
      if (failing) {
        return new Response(JSON.stringify({ reason: "polar license lookup failed" }), {
          status: 502,
        });
      }
      return Response.json({
        entitled: true,
        source: "team-automation",
        productName: "DevIntern Team",
      });
    }) as typeof fetch;

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const { checkLicense } = await import(`../src/index.ts?grace=${Date.now()}`);

    const first = await checkLicense({
      productKey: "devintern/code",
      retryBaseDelayMs: 1,
      supabaseConfig,
      requireAutomation: true,
    });
    expect(first.valid).toBe(true);
    expect(first.source).toBe("entitlement");

    const cachePath = join(supabaseConfig.sessionFilePath, "..", "license-cache.json");
    expect(existsSync(cachePath)).toBe(true);
    expect(readFileSync(cachePath, "utf8")).toContain("team-automation");

    failing = true;
    const second = await checkLicense({
      productKey: "devintern/code",
      retryBaseDelayMs: 1,
      supabaseConfig,
      requireAutomation: true,
    });
    expect(second.valid).toBe(true);
    expect(second.source).toBe("grace");
    expect(second.entitlementSource).toBe("team-automation");
    expect(second.message).toContain("License server unreachable");

    warnSpy.mockRestore();
  });

  test("definitive not-entitled clears the cache instead of granting grace", async () => {
    const supabaseConfig = freshSupabaseConfig();
    let mode: "entitled" | "denied" | "down" = "entitled";
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (!url.includes("/api/license/check")) {
        return originalFetch(input);
      }
      if (mode === "entitled") {
        return Response.json({ entitled: true, source: "team-automation" });
      }
      if (mode === "denied") {
        return Response.json({ entitled: false, reason: "no polar customer" });
      }
      return new Response("", { status: 502 });
    }) as typeof fetch;

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const { checkLicense } = await import(`../src/index.ts?revoke=${Date.now()}`);

    const first = await checkLicense({
      productKey: "devintern/code",
      retryBaseDelayMs: 1,
      supabaseConfig,
      requireAutomation: true,
    });
    expect(first.valid).toBe(true);

    mode = "denied";
    const second = await checkLicense({
      productKey: "devintern/code",
      retryBaseDelayMs: 1,
      supabaseConfig,
      requireAutomation: true,
    });
    expect(second.valid).toBe(false);
    // Signed in but not entitled is a real failure, not a pending sign-in.
    expect(second.signInRequired).toBeUndefined();

    mode = "down";
    const third = await checkLicense({
      productKey: "devintern/code",
      retryBaseDelayMs: 1,
      supabaseConfig,
      requireAutomation: true,
    });
    expect(third.valid).toBe(false);
    expect(third.source).toBe("none");

    warnSpy.mockRestore();
  });

  test("does not retry definitive 401 responses", async () => {
    let calls = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (!url.includes("/api/license/check")) {
        return originalFetch(input);
      }

      calls += 1;
      return new Response(JSON.stringify({ reason: "invalid token" }), { status: 401 });
    }) as typeof fetch;

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const { checkLicense } = await import(`../src/index.ts?d401=${Date.now()}`);

    const result = await checkLicense({
      productKey: "devintern/code",
      retryBaseDelayMs: 1,
      supabaseConfig: freshSupabaseConfig(),
    });

    expect(calls).toBe(1);
    expect(result.valid).toBe(false);
    expect(result.source).toBe("none");

    warnSpy.mockRestore();
  });

  test("returns a server-authoritative Worker Pilot only when explicitly allowed", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return Response.json({
        entitled: true,
        source: "worker-trial",
        trial: { status: "available" },
      });
    }) as typeof fetch;

    const { checkLicense } = await import(`../src/index.ts?trial-preview=${Date.now()}`);
    const result = await checkLicense({
      productKey: "devintern/code",
      supabaseConfig: freshSupabaseConfig(),
      requireAutomation: true,
      allowTrial: true,
    });

    expect(result).toMatchObject({
      valid: true,
      source: "trial",
      trialAvailable: true,
    });
    expect(urls[0]).toContain("trial=1");
  });

  test("requires login before offering a Worker Pilot", async () => {
    authenticated = false;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ entitled: true });
    }) as typeof fetch;

    const { checkLicense } = await import(`../src/index.ts?trial-login=${Date.now()}`);
    const result = await checkLicense({
      productKey: "devintern/code",
      supabaseConfig: freshSupabaseConfig(),
      requireAutomation: true,
      allowTrial: true,
    });

    expect(result.valid).toBe(false);
    expect(result.message).toContain("devintern login");
    expect(result.message).toStartWith("Sign in to start your free 14-day Worker Pilot");
    expect(result.signInRequired).toBe(true);
    expect(calls).toBe(0);

    // Without the Pilot, signing in is not the next step by itself.
    const noTrial = await checkLicense({
      productKey: "devintern/code",
      supabaseConfig: freshSupabaseConfig(),
      requireAutomation: true,
    });
    expect(noTrial.valid).toBe(false);
    expect(noTrial.signInRequired).toBeUndefined();
  });

  test("activates the Worker Pilot with the signed-in user's token", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input, init) => {
      request = { url: String(input), init };
      return Response.json({
        entitled: true,
        source: "worker-trial",
        trial: {
          status: "active",
          endsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });
    }) as typeof fetch;

    const { activateWorkerTrial } = await import(`../src/index.ts?trial-activate=${Date.now()}`);
    const result = await activateWorkerTrial({
      productKey: "devintern/code",
      supabaseConfig: freshSupabaseConfig(),
    });

    expect(result).toMatchObject({
      valid: true,
      source: "trial",
      trialAvailable: false,
    });
    expect(request?.url).toEndWith("/api/license/trial");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.headers).toMatchObject({ Authorization: "Bearer test-access-token" });
  });

  test("setup and the worker start path print the same Worker Pilot sign-in text", async () => {
    authenticated = false;
    const { checkLicense } = await import(`../src/index.ts?setup=${Date.now()}`);
    const base = {
      productKey: "devintern/code",
      supabaseConfig: freshSupabaseConfig(),
      requireAutomation: true,
      allowTrial: true,
      loginCommand: "devintern worker login",
    };

    const runtime = await checkLicense(base);
    const setup = await checkLicense({ ...base, setup: true });
    expect(setup.valid).toBe(false);
    expect(setup.message).toBe(runtime.message);
  });
});

describe("worker licence messages", () => {
  beforeEach(() => {
    authenticated = true;
    process.env.DEVINTERN_SKIP_LICENSE_CHECK = "0";
    delete process.env.LICENSE_KEY;
    process.env.DEVINTERN_API_BASE = "https://license.test";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.DEVINTERN_API_BASE;
    mock.restore();
  });

  const worker = {
    productKey: "devintern/code",
    requireAutomation: true,
    allowTrial: true,
    loginCommand: "devintern worker login",
  };

  test("never signed in: leads with the Worker Pilot sign-in, LICENSE_KEY as the alternative", async () => {
    authenticated = false;
    const result = await checkLicense({ ...worker, supabaseConfig: freshSupabaseConfig() });

    expect(result).toMatchObject({ valid: false, source: "none", signInRequired: true });
    expect(result.message).toBe(workerPilotSignInMessage("devintern worker login"));
    expect(result.message).toStartWith(
      "Sign in to start your free 14-day Worker Pilot: `devintern worker login` (no card required).",
    );
    expect(result.message).toContain(
      "Already have a Supporter, Team, or Business license? Set LICENSE_KEY in the workspace .env instead.",
    );
    expect(result.message).toEndWith(WORKER_PILOT_DOCS_URL);
    expect(WORKER_PILOT_DOCS_URL).toBe(
      "https://devintern.com/docs/code/worker#worker-pilot-and-licenses",
    );
    // The interactive form: the sign-in asks for the method.
    expect(result.message).not.toContain("worker login github");
    expect(result.message).not.toContain("Automated execution detected");
  });

  test("activating the Pilot without a session prints the same sign-in text", async () => {
    authenticated = false;
    const result = await activateWorkerTrial({
      productKey: "devintern/code",
      supabaseConfig: freshSupabaseConfig(),
      loginCommand: "devintern worker login",
    });
    expect(result.signInRequired).toBe(true);
    expect(result.message).toBe(workerPilotSignInMessage("devintern worker login"));
  });

  test("Pilot expired: names the ended Pilot and LICENSE_KEY, not another sign-in", async () => {
    globalThis.fetch = (async () =>
      Response.json({ entitled: false, reason: "worker trial ended" })) as typeof fetch;
    const result = await checkLicense({ ...worker, supabaseConfig: freshSupabaseConfig() });

    expect(result).toMatchObject({ valid: false, source: "none" });
    expect(result.signInRequired).toBeUndefined();
    expect(result.message).toStartWith(
      "Your free Worker Pilot is over and this account has no automation license.",
    );
    expect(result.message).toContain("Set LICENSE_KEY in the workspace .env");
    expect(result.message).toContain("https://devintern.com/pricing");
    expect(result.message).toEndWith(WORKER_PILOT_DOCS_URL);
    expect(result.message).not.toContain("Sign in to start");
  });

  test("invalid LICENSE_KEY: says so and offers the Pilot sign-in instead", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    const result = await checkLicense({
      ...worker,
      licenseKey: "not-a-real-key",
      supabaseConfig: freshSupabaseConfig(),
    });

    expect(result).toMatchObject({ valid: false, source: "license-key" });
    expect(result.message).toStartWith("LICENSE_KEY is invalid or revoked.");
    expect(result.message).toContain(
      "sign in to start your free 14-day Worker Pilot: `devintern worker login`",
    );
    expect(result.message).toEndWith(WORKER_PILOT_DOCS_URL);
    expect(result.message).not.toContain("not-a-real-key");

    // Without the Pilot (e.g. `webhook serve`) the key error stays short.
    const noTrial = await checkLicense({
      productKey: "devintern/code",
      requireAutomation: true,
      licenseKey: "not-a-real-key",
      supabaseConfig: freshSupabaseConfig(),
    });
    expect(noTrial.message).toBe("LICENSE_KEY is invalid or revoked.");
  });
});

describe("release build hardening", () => {
  test("skip flag is honoured outside release builds", () => {
    expect(shouldSkipLicenseCheck({ DEVINTERN_SKIP_LICENSE_CHECK: "1" }, false)).toBe(true);
    expect(shouldSkipLicenseCheck({ DEVINTERN_SKIP_LICENSE_CHECK: "0" }, false)).toBe(false);
  });

  test("skip flag is ignored in release builds", () => {
    expect(shouldSkipLicenseCheck({ DEVINTERN_SKIP_LICENSE_CHECK: "1" }, true)).toBe(false);
  });

  test("DEVINTERN_API_BASE override only applies outside release builds", () => {
    const env = { DEVINTERN_API_BASE: "https://evil.test" };
    expect(resolveApiBase(env, false)).toBe("https://evil.test");
    expect(resolveApiBase(env, true)).not.toBe("https://evil.test");
  });

  test("checkLicense denies despite the skip flag in a release build", async () => {
    const saved = process.env.DEVINTERN_SKIP_LICENSE_CHECK;
    process.env.DEVINTERN_SKIP_LICENSE_CHECK = "1";
    delete process.env.LICENSE_KEY;
    authenticated = false;
    const options = { productKey: "devintern/code", supabaseConfig: freshSupabaseConfig() };
    try {
      setReleaseBuildForTests(false);
      expect((await checkLicense(options)).valid).toBe(true);
      setReleaseBuildForTests(true);
      expect((await checkLicense(options)).valid).toBe(false);
    } finally {
      setReleaseBuildForTests(undefined);
      authenticated = true;
      if (saved === undefined) delete process.env.DEVINTERN_SKIP_LICENSE_CHECK;
      else process.env.DEVINTERN_SKIP_LICENSE_CHECK = saved;
    }
  });
});
