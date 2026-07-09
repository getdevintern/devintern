import { afterEach, beforeEach, describe, expect, mock, test, spyOn } from "bun:test";

const originalFetch = globalThis.fetch;

function recentTrialStart(): string {
  const started = new Date();
  started.setDate(started.getDate() - 1);
  return started.toISOString();
}

mock.module("@devintern/auth", () => ({
  getAuthenticatedUser: async () => ({
    id: "user-1",
    email: "test@example.com",
    createdAt: recentTrialStart(),
    accessToken: "test-access-token",
  }),
  getUserTrialStartedAt: async () => recentTrialStart(),
}));

describe("checkLicense entitlement API", () => {
  beforeEach(() => {
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
      supabaseConfig: {
        url: "https://x.supabase.co",
        publishableKey: "pk",
        sessionFilePath: "/tmp/session.json",
      },
      allowTrial: true,
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

  test("logs error and uses trial when entitlement check keeps failing", async () => {
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

    const { checkLicense } = await import(`../src/index.ts?trial=${Date.now()}`);

    const result = await checkLicense({
      productKey: "devintern/code",
      supabaseConfig: {
        url: "https://x.supabase.co",
        publishableKey: "pk",
        sessionFilePath: "/tmp/session.json",
      },
      allowTrial: true,
    });

    expect(result.valid).toBe(true);
    expect(result.source).toBe("trial");
    expect(result.message).toContain("Entitlement check unavailable");
    expect(result.message).toContain("HTTP 502: polar license lookup failed");
    const entitlementFailureWarn = warnSpy.mock.calls.find((call) =>
      String(call[0]).includes("License entitlement check failed"),
    );
    expect(entitlementFailureWarn).toBeDefined();
    expect(String(entitlementFailureWarn?.[0])).toContain("3 attempts");

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

    const { checkLicense } = await import(`../src/index.ts?401=${Date.now()}`);

    const result = await checkLicense({
      productKey: "devintern/code",
      supabaseConfig: {
        url: "https://x.supabase.co",
        publishableKey: "pk",
        sessionFilePath: "/tmp/session.json",
      },
      allowTrial: true,
    });

    expect(calls).toBe(1);
    expect(result.source).toBe("trial");
    expect(result.message).toContain("HTTP 401: invalid token");

    warnSpy.mockRestore();
  });
});
