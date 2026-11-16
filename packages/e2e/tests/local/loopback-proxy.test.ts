import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureLoopbackBypassesProxy, withLoopbackNoProxy } from "../../helpers/loopback-proxy";

/** Discard port: nothing listens there, so a proxied request cannot succeed. */
const DEAD_PROXY = "http://127.0.0.1:9";

const PROXY_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

/** Whether this host can bind IPv6 loopback, so the `::1` case is not flaky. */
function hasIpv6Loopback(): boolean {
  try {
    const probe = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("ok") });
    void probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Fetch `url`, returning the status or the connection error message. */
async function probe(url: string): Promise<number | string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    await response.arrayBuffer();
    return response.status;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("withLoopbackNoProxy", () => {
  test("appends every loopback spelling, including bracketed IPv6", () => {
    expect(withLoopbackNoProxy(undefined)).toBe("localhost,127.0.0.1,::1,[::1]");
    expect(withLoopbackNoProxy("")).toBe("localhost,127.0.0.1,::1,[::1]");
  });

  test("keeps existing entries and order and does not duplicate", () => {
    expect(withLoopbackNoProxy("localhost,127.0.0.1,::1,.corp.example")).toBe(
      "localhost,127.0.0.1,::1,.corp.example,[::1]",
    );
    expect(withLoopbackNoProxy(" LOCALHOST , [::1] ")).toBe("LOCALHOST,[::1],127.0.0.1,::1");
    const once = withLoopbackNoProxy("example.com");
    expect(withLoopbackNoProxy(once)).toBe(once);
  });
});

describe("ensureLoopbackBypassesProxy", () => {
  test("updates both spellings and leaves proxy variables untouched", () => {
    const env: Record<string, string | undefined> = {
      HTTP_PROXY: DEAD_PROXY,
      https_proxy: DEAD_PROXY,
      NO_PROXY: "localhost,127.0.0.1,::1,internal.example",
    };
    ensureLoopbackBypassesProxy(env);
    expect(env.HTTP_PROXY).toBe(DEAD_PROXY);
    expect(env.https_proxy).toBe(DEAD_PROXY);
    // The lowercase spelling wins in Bun, so it must inherit the remote
    // exclusions rather than shadow them with a loopback-only list.
    expect(env.no_proxy).toBe("localhost,127.0.0.1,::1,internal.example,[::1]");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,internal.example,[::1]");
  });

  test("keeps distinct existing values for each spelling", () => {
    const env: Record<string, string | undefined> = {
      no_proxy: "a.example",
      NO_PROXY: "b.example",
    };
    ensureLoopbackBypassesProxy(env);
    expect(env.no_proxy).toBe("a.example,localhost,127.0.0.1,::1,[::1]");
    expect(env.NO_PROXY).toBe("b.example,localhost,127.0.0.1,::1,[::1]");
  });
});

describe.skipIf(!hasIpv6Loopback())("IPv6 loopback fetch behind a configured proxy", () => {
  let saved: Partial<Record<(typeof PROXY_KEYS)[number], string | undefined>>;
  let server: ReturnType<typeof Bun.serve>;
  let url: string;

  beforeEach(() => {
    saved = Object.fromEntries(PROXY_KEYS.map((key) => [key, process.env[key]]));
    // Overwrite rather than `delete`: Bun 1.4.2 falls back to the startup
    // value of a deleted proxy variable, which would leak the host's real
    // proxy or the preload's bypass list into these cases.
    for (const key of PROXY_KEYS) {
      process.env[key] = key.toLowerCase() === "no_proxy" ? "" : DEAD_PROXY;
    }
    server = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("ok") });
    url = `http://[::1]:${server.port}/`;
  });

  afterEach(async () => {
    await server.stop(true);
    for (const key of PROXY_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("control: without a loopback bypass the request goes to the dead proxy", async () => {
    process.env.NO_PROXY = "localhost";
    process.env.no_proxy = "localhost";
    expect(await probe(url)).not.toBe(200);
  });

  test("the helper lets fetch reach a Bun.serve on ::1 directly", async () => {
    // The worker's real shape: `::1` is listed, but not the bracketed form.
    process.env.NO_PROXY = "localhost,127.0.0.1,::1";
    process.env.no_proxy = "localhost,127.0.0.1,::1";
    ensureLoopbackBypassesProxy();
    expect(process.env.HTTP_PROXY).toBe(DEAD_PROXY);
    expect(await probe(url)).toBe(200);
  });

  test("the helper bypasses the proxy even when the bypass list is empty", async () => {
    ensureLoopbackBypassesProxy();
    expect(await probe(url)).toBe(200);
  });
});
