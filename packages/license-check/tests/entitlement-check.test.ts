import { afterEach, beforeEach, describe, expect, mock, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
        trial: { status: "available", tasksRemaining: 10 },
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
      trialTasksRemaining: 10,
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
    expect(result.message).toContain("no card is required");
    expect(calls).toBe(0);
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
          tasksRemaining: 10,
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
      trialTasksRemaining: 10,
    });
    expect(request?.url).toEndWith("/api/license/trial");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.headers).toMatchObject({ Authorization: "Bearer test-access-token" });
  });

  test("claims a trial task with an idempotent task identity", async () => {
    let body = "";
    globalThis.fetch = (async (_input, init) => {
      body = String(init?.body);
      return Response.json({
        entitled: true,
        source: "worker-trial",
        trial: {
          status: "active",
          endsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          tasksRemaining: 9,
        },
      });
    }) as typeof fetch;

    const { claimWorkerTrialTask } = await import(`../src/index.ts?trial-claim=${Date.now()}`);
    const result = await claimWorkerTrialTask({
      productKey: "devintern/code",
      supabaseConfig: freshSupabaseConfig(),
      taskId: "worker:DEV-42",
    });

    expect(JSON.parse(body)).toEqual({
      productKey: "devintern/code",
      taskFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.trialTasksRemaining).toBe(9);
  });
});
