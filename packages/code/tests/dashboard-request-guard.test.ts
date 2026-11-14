import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { checkDashboardRequest, startDashboardServer } from "../src/dashboard-server";

const PORT = 4400;
const JSON_TYPE = { "Content-Type": "application/json" };

function request(
  method: string,
  headers: Record<string, string>,
  path = "/api/runs/1/retry",
): Request {
  return new Request(`http://127.0.0.1:${PORT}${path}`, { method, headers });
}

describe("checkDashboardRequest", () => {
  test("accepts GETs addressed to a loopback host on the bound port", () => {
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
      expect(checkDashboardRequest(request("GET", { Host: host }, "/api/runs"), PORT)).toBeNull();
    }
  });

  test("rejects a rebound or mismatched Host on every method", () => {
    for (const host of [
      `evil.example.com:${PORT}`,
      "127.0.0.1:4401",
      "127.0.0.1",
      `127.0.0.1.evil.example.com:${PORT}`,
      "",
    ]) {
      const rejection = checkDashboardRequest(request("GET", { Host: host }, "/api/runs"), PORT);
      expect(rejection?.status).toBe(403);
    }
    const post = request("POST", {
      Host: `rebind.example.com:${PORT}`,
      Origin: `http://rebind.example.com:${PORT}`,
      ...JSON_TYPE,
    });
    expect(checkDashboardRequest(post, PORT)?.status).toBe(403);
  });

  test("accepts a same-origin JSON POST from any loopback origin on the bound port", () => {
    for (const origin of [
      `http://127.0.0.1:${PORT}`,
      `http://localhost:${PORT}`,
      `http://[::1]:${PORT}`,
    ]) {
      const post = request("POST", { Host: `127.0.0.1:${PORT}`, Origin: origin, ...JSON_TYPE });
      expect(checkDashboardRequest(post, PORT)).toBeNull();
    }
    const charset = request("POST", {
      Host: `localhost:${PORT}`,
      Origin: `http://localhost:${PORT}`,
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(checkDashboardRequest(charset, PORT)).toBeNull();
  });

  test("rejects cross-origin, wrong-port, https, and opaque origins", () => {
    for (const origin of [
      "https://evil.example.com",
      `http://evil.example.com:${PORT}`,
      "http://127.0.0.1:5173",
      `https://127.0.0.1:${PORT}`,
      "null",
    ]) {
      const post = request("POST", { Host: `127.0.0.1:${PORT}`, Origin: origin, ...JSON_TYPE });
      expect(checkDashboardRequest(post, PORT)?.status).toBe(403);
    }
  });

  test("a missing Origin passes only with Sec-Fetch-Site: same-origin", () => {
    const bare = request("POST", { Host: `127.0.0.1:${PORT}`, ...JSON_TYPE });
    expect(checkDashboardRequest(bare, PORT)?.status).toBe(403);
    const crossSite = request("POST", {
      Host: `127.0.0.1:${PORT}`,
      "Sec-Fetch-Site": "cross-site",
      ...JSON_TYPE,
    });
    expect(checkDashboardRequest(crossSite, PORT)?.status).toBe(403);
    const sameOrigin = request("POST", {
      Host: `127.0.0.1:${PORT}`,
      "Sec-Fetch-Site": "same-origin",
      ...JSON_TYPE,
    });
    expect(checkDashboardRequest(sameOrigin, PORT)).toBeNull();
  });

  test("rejects a non-JSON content type with 415", () => {
    for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
      const headers: Record<string, string> = {
        Host: `127.0.0.1:${PORT}`,
        Origin: `http://127.0.0.1:${PORT}`,
      };
      if (contentType) headers["Content-Type"] = contentType;
      expect(checkDashboardRequest(request("POST", headers), PORT)?.status).toBe(415);
    }
  });
});

describe("dashboard server request guard", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "devintern-dashboard-guard-"));
    dbPath = join(dir, "queue.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("guards every /api route before dispatch", async () => {
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
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const runUrl = `${base}/api/automations/nightly/run`;

      const health = await fetch(`${base}/api/health`);
      expect(health.status).toBe(200);

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

      const sameOrigin = await fetch(runUrl, {
        method: "POST",
        headers: { Origin: base, ...JSON_TYPE },
        body: "{}",
      });
      expect(sameOrigin.status).toBe(202);
      expect(triggers).toEqual(["nightly"]);
    } finally {
      server.stop(true);
    }
  });
});
