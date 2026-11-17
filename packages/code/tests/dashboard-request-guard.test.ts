import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { checkDashboardRequest, startDashboardServer } from "../src/dashboard-server";
import {
  isDashboardTailscaleAutodetectDisabledByEnv,
  parseDashboardAllowedOrigin,
  parseDashboardAllowedOriginList,
  parseDashboardAllowedOriginsEnv,
} from "../src/lib/observability/dashboard-origins";
import type { DashboardAllowedOrigin } from "../src/lib/observability/dashboard-origins";
import {
  parseTailscaleServeStatus,
  TailscaleOriginDetector,
  tailscaleOriginsForDashboard,
  tailscaleProxyTargetsDashboard,
} from "../src/lib/observability/dashboard-tailscale";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";

const JSON_TYPE = { "Content-Type": "application/json" };
const TS_HOST = "omarchy.tail125e4f.ts.net";

function request(
  method: string,
  headers: Record<string, string>,
  path = "/api/runs/1/retry",
): Request {
  return new Request(`http://127.0.0.1:4400${path}`, { method, headers });
}

function origin(entry: string): DashboardAllowedOrigin {
  const result = parseDashboardAllowedOrigin(entry);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** The status the user's tailscale 1.102.3 reports for `tailscale serve --bg 4400`. */
function serveStatus(proxy = "http://127.0.0.1:4400", funnel = false): string {
  return JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Web: { [`${TS_HOST}:443`]: { Handlers: { "/": { Proxy: proxy } } } },
    ...(funnel ? { AllowFunnel: { [`${TS_HOST}:443`]: true } } : {}),
  });
}

describe("checkDashboardRequest: loopback", () => {
  test("accepts GETs on any loopback name and any port", () => {
    for (const host of [
      "127.0.0.1:4400",
      "localhost:8440",
      "[::1]:4400",
      "LOCALHOST:9",
      "localhost",
    ]) {
      expect(checkDashboardRequest(request("GET", { Host: host }, "/api/runs"))).toBeNull();
    }
  });

  test("accepts a write whose Origin is http://<Host>, including a remapped tunnel port", () => {
    for (const host of ["127.0.0.1:4400", "localhost:8440", "[::1]:4400"]) {
      const post = request("POST", { Host: host, Origin: `http://${host}`, ...JSON_TYPE });
      expect(checkDashboardRequest(post)).toBeNull();
    }
    const charset = request("POST", {
      Host: "localhost:8440",
      Origin: "http://localhost:8440",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(checkDashboardRequest(charset)).toBeNull();
  });

  test("rejects a write whose Origin does not match the Host", () => {
    for (const badOrigin of [
      "http://localhost:3000", // another local app
      "http://127.0.0.1:4400", // same port, different loopback name
      "https://localhost:8440",
      "https://evil.example.com",
      "null",
    ]) {
      const post = request("POST", { Host: "localhost:8440", Origin: badOrigin, ...JSON_TYPE });
      expect(checkDashboardRequest(post)).toMatchObject({ status: 403, reason: "origin" });
    }
  });

  test("a missing Origin passes only with Sec-Fetch-Site: same-origin", () => {
    const base = { Host: "127.0.0.1:4400", ...JSON_TYPE };
    expect(checkDashboardRequest(request("POST", base))?.status).toBe(403);
    expect(
      checkDashboardRequest(request("POST", { ...base, "Sec-Fetch-Site": "cross-site" }))?.status,
    ).toBe(403);
    expect(
      checkDashboardRequest(request("POST", { ...base, "Sec-Fetch-Site": "same-origin" })),
    ).toBeNull();
  });

  test("rejects a non-JSON content type with 415", () => {
    for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
      const headers: Record<string, string> = {
        Host: "127.0.0.1:4400",
        Origin: "http://127.0.0.1:4400",
      };
      if (contentType) headers["Content-Type"] = contentType;
      expect(checkDashboardRequest(request("POST", headers))).toMatchObject({
        status: 415,
        reason: "content-type",
      });
    }
  });
});

describe("checkDashboardRequest: rebinding and allowed origins", () => {
  test("rejects a rebound or malformed Host on every method", () => {
    for (const host of [
      "evil.example.com:4400",
      "127.0.0.1.evil.example.com:4400",
      "localhost.evil.example.com",
      "user@localhost:4400",
      "",
    ]) {
      expect(checkDashboardRequest(request("GET", { Host: host }, "/api/runs"))).toMatchObject({
        status: 403,
        reason: "host",
      });
    }
    const post = request("POST", {
      Host: "rebind.example.com:4400",
      Origin: "http://rebind.example.com:4400",
      ...JSON_TYPE,
    });
    expect(checkDashboardRequest(post)?.reason).toBe("host");
  });

  test("never trusts X-Forwarded-* headers", () => {
    const forwarded = request(
      "GET",
      { Host: TS_HOST, "X-Forwarded-Host": "localhost:4400", "X-Forwarded-For": "127.0.0.1" },
      "/api/runs",
    );
    expect(checkDashboardRequest(forwarded)?.reason).toBe("host");
  });

  test("accepts an allowlisted Host with its matching https Origin", () => {
    const allowedOrigins = [origin(`https://${TS_HOST}`)];
    expect(
      checkDashboardRequest(request("GET", { Host: TS_HOST }, "/api/runs"), { allowedOrigins }),
    ).toBeNull();
    // An explicit default port in the Host is the same authority.
    expect(
      checkDashboardRequest(request("GET", { Host: `${TS_HOST}:443` }, "/api/runs"), {
        allowedOrigins,
      }),
    ).toBeNull();
    const post = request("POST", { Host: TS_HOST, Origin: `https://${TS_HOST}`, ...JSON_TYPE });
    expect(checkDashboardRequest(post, { allowedOrigins })).toBeNull();
  });

  test("rejects an allowlisted Host with the wrong Origin", () => {
    const allowedOrigins = [origin(`https://${TS_HOST}`), origin("https://other.example.com")];
    for (const badOrigin of [
      `http://${TS_HOST}`,
      "https://other.example.com",
      "https://evil.example.com",
    ]) {
      const post = request("POST", { Host: TS_HOST, Origin: badOrigin, ...JSON_TYPE });
      expect(checkDashboardRequest(post, { allowedOrigins })?.reason).toBe("origin");
    }
    // A different port on the allowlisted name is a different origin.
    expect(
      checkDashboardRequest(request("GET", { Host: `${TS_HOST}:8443` }, "/api/runs"), {
        allowedOrigins,
      })?.reason,
    ).toBe("host");
  });

  test("accepts an allowlisted Origin on a loopback Host (proxy rewrote Host)", () => {
    const allowedOrigins = [origin("https://dash.example.internal")];
    const post = request("POST", {
      Host: "127.0.0.1:4400",
      Origin: "https://dash.example.internal",
      ...JSON_TYPE,
    });
    expect(checkDashboardRequest(post, { allowedOrigins })).toBeNull();
  });
});

describe("allowed origin parsing", () => {
  test("normalizes case, default ports, and a trailing slash", () => {
    expect(origin("HTTPS://Box.Tailnet.TS.net:443/")).toMatchObject({
      origin: "https://box.tailnet.ts.net",
      host: "box.tailnet.ts.net",
      scheme: "https:",
      source: "explicit",
    });
    expect(origin("http://10.0.0.5:8088")).toMatchObject({
      origin: "http://10.0.0.5:8088",
      host: "10.0.0.5:8088",
    });
  });

  test("rejects paths, userinfo, wildcards, queries, and other schemes", () => {
    for (const entry of [
      "https://box.ts.net/dashboard",
      "https://user:pw@box.ts.net",
      "https://*.ts.net",
      "https://box.ts.net?x=1",
      "https://box.ts.net#frag",
      "ftp://box.ts.net",
      "box.ts.net",
      "",
    ]) {
      expect(parseDashboardAllowedOrigin(entry).ok).toBe(false);
    }
  });

  test("parses the env var and the flag list, collecting one error per bad entry", () => {
    const env = parseDashboardAllowedOriginsEnv(" https://a.ts.net , http://b.lan:8088,, ");
    expect(env.errors).toEqual([]);
    expect(env.origins.map((entry) => entry.origin)).toEqual([
      "https://a.ts.net",
      "http://b.lan:8088",
    ]);
    expect(parseDashboardAllowedOriginsEnv(undefined)).toEqual({ origins: [], errors: [] });
    const bad = parseDashboardAllowedOriginsEnv("https://ok.ts.net,https://bad.ts.net/path");
    expect(bad.origins).toHaveLength(1);
    expect(bad.errors).toEqual([expect.stringContaining("DASHBOARD_ALLOWED_ORIGINS")]);

    const flags = parseDashboardAllowedOriginList(["https://a.ts.net", "*"], "--allow-origin");
    expect(flags.origins).toHaveLength(1);
    expect(flags.errors).toEqual([expect.stringContaining("--allow-origin")]);
  });

  test("DASHBOARD_TAILSCALE_AUTODETECT accepts the usual off values", () => {
    for (const value of ["0", "false", "OFF", "no"]) {
      expect(isDashboardTailscaleAutodetectDisabledByEnv(value)).toBe(true);
    }
    for (const value of [undefined, "", "1", "true"]) {
      expect(isDashboardTailscaleAutodetectDisabledByEnv(value)).toBe(false);
    }
  });

  test("workspace.toml [dashboard] parses into allowed origins and the autodetect switch", () => {
    const base = '[defaults]\ntracker = "jira"\n';
    expect(parseWorkspaceConfig(base).dashboard).toEqual({
      allowedOrigins: [],
      tailscaleAutodetect: true,
    });
    const config = parseWorkspaceConfig(
      `${base}[dashboard]\nallowed_origins = ["https://box.ts.net/"]\ntailscale_autodetect = false\n`,
    );
    expect(config.dashboard.tailscaleAutodetect).toBe(false);
    expect(config.dashboard.allowedOrigins.map((entry) => entry.origin)).toEqual([
      "https://box.ts.net",
    ]);
  });

  test("workspace.toml rejects malformed [dashboard] entries at load", () => {
    const base = '[defaults]\ntracker = "jira"\n';
    expect(() =>
      parseWorkspaceConfig(`${base}[dashboard]\nallowed_origins = ["https://box.ts.net/app"]\n`),
    ).toThrow("[dashboard].allowed_origins: invalid dashboard allowed origin");
    expect(() => parseWorkspaceConfig(`${base}[dashboard]\nallowed_origins = "x"\n`)).toThrow(
      "[dashboard].allowed_origins must be an array of non-empty strings.",
    );
    expect(() => parseWorkspaceConfig(`${base}[dashboard]\ntailscale_autodetect = "no"\n`)).toThrow(
      "[dashboard].tailscale_autodetect must be a boolean.",
    );
    expect(() => parseWorkspaceConfig(`${base}[dashboard]\nallowed_origin = []\n`)).toThrow(
      "[dashboard].allowed_origin is not supported",
    );
  });
});

describe("Tailscale Serve detection", () => {
  test("a handler proxying to this dashboard yields its https origin", () => {
    const status = parseTailscaleServeStatus(serveStatus());
    expect(status).not.toBeNull();
    expect(tailscaleOriginsForDashboard(status!, 4400)).toEqual([
      { origin: `https://${TS_HOST}`, host: TS_HOST, scheme: "https:", source: "tailscale-serve" },
    ]);
  });

  test("accepts every proxy form tailscale stores for a loopback target", () => {
    for (const proxy of [
      "4400",
      "localhost:4400",
      "127.0.0.1:4400",
      "http://localhost:4400",
      "http://127.0.0.1:4400/",
      "http://[::1]:4400",
    ]) {
      expect(tailscaleProxyTargetsDashboard(proxy, 4400)).toBe(true);
    }
    for (const proxy of [
      "4401",
      "http://127.0.0.1:4401",
      "https+insecure://127.0.0.1:4400",
      "https://127.0.0.1:4400",
      "http://10.0.0.5:4400",
      "unix:/tmp/dash.sock",
    ]) {
      expect(tailscaleProxyTargetsDashboard(proxy, 4400)).toBe(false);
    }
  });

  test("a handler pointing at a different port is not trusted", () => {
    const status = parseTailscaleServeStatus(serveStatus("http://127.0.0.1:3000"))!;
    expect(tailscaleOriginsForDashboard(status, 4400)).toEqual([]);
  });

  test("a non-443 serve port is part of the origin; funnel is flagged", () => {
    const status = parseTailscaleServeStatus(
      JSON.stringify({
        Web: { [`${TS_HOST}:8443`]: { Handlers: { "/": { Proxy: "4400" } } } },
        AllowFunnel: { [`${TS_HOST}:8443`]: true },
        Future: { unknown: true },
      }),
    )!;
    expect(tailscaleOriginsForDashboard(status, 4400)).toEqual([
      {
        origin: `https://${TS_HOST}:8443`,
        host: `${TS_HOST}:8443`,
        scheme: "https:",
        source: "tailscale-funnel",
      },
    ]);
  });

  test("garbage or empty output parses to nothing", () => {
    expect(parseTailscaleServeStatus("not json")).toBeNull();
    expect(parseTailscaleServeStatus("[]")).toBeNull();
    expect(parseTailscaleServeStatus("{}")).toEqual({ web: [] });
    expect(parseTailscaleServeStatus('{"Web":{"x:443":{"Handlers":"nope"}}}')).toEqual({ web: [] });
  });

  test("a missing binary or garbage output is a no-op", async () => {
    for (const probe of [
      async () => null,
      async () => "garbage",
      async () => Promise.reject(new Error("boom")),
    ]) {
      const detector = new TailscaleOriginDetector({ boundPort: 4400, probe });
      expect(await detector.refresh()).toEqual([]);
      expect(detector.current).toEqual([]);
    }
  });

  test("refreshIfStale re-runs detection at most once per interval", async () => {
    let now = 1_000;
    let calls = 0;
    let output: string | null = null;
    const changes: string[][] = [];
    const detector = new TailscaleOriginDetector({
      boundPort: 4400,
      now: () => now,
      refreshIntervalMs: 30_000,
      probe: async () => {
        calls++;
        return output;
      },
      onChange: (origins) => changes.push(origins.map((entry) => entry.origin)),
    });
    await detector.refresh();
    expect(calls).toBe(1);

    // Serve configured after startup: within the interval nothing re-runs.
    output = serveStatus();
    now += 10_000;
    expect(await detector.refreshIfStale()).toEqual([]);
    expect(calls).toBe(1);

    // After the interval the next unknown Host triggers one detection.
    now += 25_000;
    expect((await detector.refreshIfStale()).map((entry) => entry.origin)).toEqual([
      `https://${TS_HOST}`,
    ]);
    expect(calls).toBe(2);
    expect(changes).toEqual([[`https://${TS_HOST}`]]);

    // Concurrent callers share one in-flight probe.
    now += 31_000;
    await Promise.all([detector.refreshIfStale(), detector.refreshIfStale()]);
    expect(calls).toBe(3);
  });
});

describe("dashboard server request guard", () => {
  let dir: string;
  let dbPath: string;
  let savedAutodetect: string | undefined;
  let savedOrigins: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "devintern-dashboard-guard-"));
    dbPath = join(dir, "queue.db");
    savedAutodetect = process.env.DASHBOARD_TAILSCALE_AUTODETECT;
    savedOrigins = process.env.DASHBOARD_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedAutodetect === undefined) delete process.env.DASHBOARD_TAILSCALE_AUTODETECT;
    else process.env.DASHBOARD_TAILSCALE_AUTODETECT = savedAutodetect;
    if (savedOrigins === undefined) delete process.env.DASHBOARD_ALLOWED_ORIGINS;
    else process.env.DASHBOARD_ALLOWED_ORIGINS = savedOrigins;
  });

  function automationServer(extra: Parameters<typeof startDashboardServer>[0] = {}) {
    const triggers: string[] = [];
    const server = startDashboardServer({
      port: 0,
      dbPath,
      workingDir: dir,
      automationActions: {
        list: () => [
          { id: "nightly", enabled: true, interval: "1d", prompt: "Tidy up.", openPr: false },
        ],
        trigger: async (automationId) => {
          triggers.push(automationId);
          return { ok: true };
        },
      },
      automationDeps: { resolveActor: async () => null },
      ...extra,
    });
    return { server, triggers };
  }

  test("guards every /api route before dispatch", async () => {
    const { server, triggers } = automationServer();
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const runUrl = `${base}/api/automations/nightly/run`;

      expect((await fetch(`${base}/api/health`)).status).toBe(200);
      // A remapped tunnel port (Host localhost:8440) still reads.
      expect(
        (await fetch(`${base}/api/health`, { headers: { Host: "localhost:8440" } })).status,
      ).toBe(200);

      const rebound = await fetch(`${base}/api/health`, {
        headers: { Host: `attacker.example.com:${server.port}` },
      });
      expect(rebound.status).toBe(403);
      expect(((await rebound.json()) as { error: string }).error).toContain("forbidden host");

      const crossOrigin = await fetch(runUrl, {
        method: "POST",
        headers: { Origin: "https://evil.example.com", ...JSON_TYPE },
        body: "{}",
      });
      expect(crossOrigin.status).toBe(403);

      const simpleForm = await fetch(runUrl, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "text/plain" },
        body: "{}",
      });
      expect(simpleForm.status).toBe(415);
      expect(triggers).toEqual([]);

      const tunnel = await fetch(runUrl, {
        method: "POST",
        headers: { Host: "localhost:8440", Origin: "http://localhost:8440", ...JSON_TYPE },
        body: "{}",
      });
      expect(tunnel.status).toBe(202);
      expect(triggers).toEqual(["nightly"]);

      // A same-origin write passes the guard (409: the first run is in flight).
      const sameOrigin = await fetch(runUrl, {
        method: "POST",
        headers: { Origin: base, ...JSON_TYPE },
        body: "{}",
      });
      expect(sameOrigin.status).toBe(409);
    } finally {
      server.stop(true);
    }
  });

  test("explicit and env allowed origins are honored and logged with a warning", async () => {
    process.env.DASHBOARD_ALLOWED_ORIGINS = "https://env.example.internal";
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { server, triggers } = automationServer({
      allowedOrigins: [origin("https://dash.example.internal")],
    });
    try {
      const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain(
        "Allowed origins: https://dash.example.internal, https://env.example.internal",
      );
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "Anyone who can reach these addresses gets full dashboard access",
      );

      const base = `http://127.0.0.1:${server.port}`;
      const ok = await fetch(`${base}/api/automations/nightly/run`, {
        method: "POST",
        headers: {
          Host: "env.example.internal",
          Origin: "https://env.example.internal",
          ...JSON_TYPE,
        },
        body: "{}",
      });
      expect(ok.status).toBe(202);
      expect(triggers).toEqual(["nightly"]);
    } finally {
      server.stop(true);
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("a malformed DASHBOARD_ALLOWED_ORIGINS fails startup", () => {
    process.env.DASHBOARD_ALLOWED_ORIGINS = "https://box.ts.net/path";
    expect(() => automationServer()).toThrow("DASHBOARD_ALLOWED_ORIGINS");
  });

  test("auto-detects a tailscale serve name, lazily and only for this port", async () => {
    process.env.DASHBOARD_TAILSCALE_AUTODETECT = "1";
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let output: string | null = null;
    let calls = 0;
    let boundPort = 0;
    const { server, triggers } = automationServer({
      tailscaleProbe: async () => {
        calls++;
        return output === null ? null : output.replaceAll("4400", String(boundPort));
      },
    });
    boundPort = server.port ?? 0;
    try {
      const base = `http://127.0.0.1:${server.port}`;
      // Startup detection found nothing.
      const before = await fetch(`${base}/api/health`, { headers: { Host: TS_HOST } });
      expect(before.status).toBe(403);
      const callsAfterFirst = calls;

      // `tailscale serve` is configured after startup; within the refresh
      // interval the rejection stands without spawning another probe.
      output = serveStatus();
      expect((await fetch(`${base}/api/health`, { headers: { Host: TS_HOST } })).status).toBe(403);
      expect(calls).toBe(callsAfterFirst);
    } finally {
      server.stop(true);
    }

    // A fresh server picks it up at startup and accepts the serve origin.
    const second = automationServer({
      tailscaleProbe: async () => {
        await Bun.sleep(0); // the server binds before its port is read
        return serveStatus().replaceAll("4400", String(second.server.port));
      },
    });
    try {
      const base = `http://127.0.0.1:${second.server.port}`;
      const read = await fetch(`${base}/api/health`, { headers: { Host: TS_HOST } });
      expect(read.status).toBe(200);
      const write = await fetch(`${base}/api/automations/nightly/run`, {
        method: "POST",
        headers: { Host: TS_HOST, Origin: `https://${TS_HOST}`, ...JSON_TYPE },
        body: "{}",
      });
      expect(write.status).toBe(202);
      expect(second.triggers).toEqual(["nightly"]);
      expect(triggers).toEqual([]);
      expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        `Tailscale Serve origins (auto-detected): https://${TS_HOST}`,
      );
    } finally {
      second.server.stop(true);
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("a funnel-exposed dashboard is still allowed but warns loudly", async () => {
    process.env.DASHBOARD_TAILSCALE_AUTODETECT = "1";
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { server } = automationServer({
      tailscaleProbe: async () => {
        await Bun.sleep(0); // the server binds before its port is read
        return serveStatus(`http://127.0.0.1:${server.port}`, true);
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/api/health`, { headers: { Host: TS_HOST } })).status).toBe(200);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "PUBLIC INTERNET",
      );
    } finally {
      server.stop(true);
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("opt-outs disable detection entirely", async () => {
    let calls = 0;
    const probe = async () => {
      calls++;
      return serveStatus();
    };
    process.env.DASHBOARD_TAILSCALE_AUTODETECT = "1";
    const viaOption = automationServer({ tailscaleAutodetect: false, tailscaleProbe: probe });
    process.env.DASHBOARD_TAILSCALE_AUTODETECT = "0";
    const viaEnv = automationServer({ tailscaleProbe: probe });
    try {
      for (const server of [viaOption.server, viaEnv.server]) {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/health`, {
          headers: { Host: TS_HOST },
        });
        expect(response.status).toBe(403);
      }
      expect(calls).toBe(0);
    } finally {
      viaOption.server.stop(true);
      viaEnv.server.stop(true);
    }
  });
});
