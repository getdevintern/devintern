/**
 * Dashboard Server
 *
 * Serves the local observability dashboard: a read-only JSON API over the
 * worker's SQLite state (handlers in `lib/dashboard-api.ts`) plus the static
 * UI built from `packages/dashboard-ui`. Started standalone by
 * `devintern dashboard`, or alongside the daemon by `devintern worker`.
 *
 * All data stays in the customer's SQLite; the server binds to localhost by
 * default and there is no authentication, so a non-loopback host is warned
 * about loudly.
 */

import { existsSync } from "fs";
import { join, normalize, resolve } from "path";

import {
  DashboardData,
  handleLogs,
  handleRetryRun,
  handleRuns,
  handleRunDetail,
  handleStats,
  handleWorkerStatus,
} from "./lib/dashboard-api";
import type { RetryHandlerDeps } from "./lib/dashboard-api";

export const DEFAULT_DASHBOARD_PORT = 4400;

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  /** Project root used to locate the worker lock file. */
  workingDir?: string;
  /** Collaborator overrides for the retry action (tests). */
  retryDeps?: RetryHandlerDeps;
  /** Directories to search for worker capture files (primary first). */
  logDirs?: string[];
}

/** Resolve the built dashboard UI directory, or null when not shipped/built. */
export function resolveUiDir(): string | null {
  const candidates = [
    // Published package: dist/index.js next to dist/dashboard-ui/
    join(import.meta.dir, "dashboard-ui"),
    // Monorepo source run (bun run src/index.ts): sibling workspace package
    join(import.meta.dir, "..", "..", "dashboard-ui", "dist"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return null;
}

function json(payload: { status: number; body: unknown }): Response {
  return new Response(JSON.stringify(payload.body), {
    status: payload.status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Serve a file from the UI dir, confined to it; null on miss/traversal. */
function serveStatic(uiDir: string, pathname: string): Response | null {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = normalize(join(uiDir, relative));
  if (!filePath.startsWith(resolve(uiDir))) {
    return null;
  }
  if (!existsSync(filePath)) {
    return null;
  }
  return new Response(Bun.file(filePath));
}

const MISSING_UI_PAGE =
  "devintern dashboard: UI assets not found.\n\n" +
  "The JSON API is available under /api (try /api/runs, /api/stats, /api/worker).\n" +
  "If you are running from source, build the UI first:\n" +
  "  bun run --filter @devintern/dashboard-ui build\n";

/**
 * Start the dashboard HTTP server.
 *
 * @param options - Port (default 4400 or DASHBOARD_PORT), host (default
 *                  localhost), database path, and project root
 * @returns The running Bun server (stop with `server.stop()`)
 */
export function startDashboardServer(
  options: DashboardServerOptions = {},
): ReturnType<typeof Bun.serve> {
  const port =
    options.port ?? parseInt(process.env.DASHBOARD_PORT || String(DEFAULT_DASHBOARD_PORT), 10);
  const host = options.host ?? "127.0.0.1";
  const data = new DashboardData({
    dbPath: options.dbPath,
    workingDir: options.workingDir,
    logDirs: options.logDirs,
  });
  const uiDir = resolveUiDir();

  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(
      `⚠️  Dashboard binding to ${host} — it has no authentication. ` +
        "Anyone who can reach this address can read run history.",
    );
  }

  const runDetailPattern = /^\/api\/runs\/([^/]+)$/;
  const runRetryPattern = /^\/api\/runs\/([^/]+)\/retry$/;

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname.startsWith("/api")) {
        const retry = request.method === "POST" ? pathname.match(runRetryPattern) : null;
        if (retry) {
          return json(await handleRetryRun(data, retry[1], options.retryDeps));
        }
        if (request.method !== "GET") {
          return json({ status: 405, body: { error: "method not allowed" } });
        }
        if (pathname === "/api/health") {
          return json({ status: 200, body: { status: "ok" } });
        }
        if (pathname === "/api/runs") {
          return json(handleRuns(data, url.searchParams));
        }
        const runDetail = pathname.match(runDetailPattern);
        if (runDetail) {
          return json(handleRunDetail(data, runDetail[1]));
        }
        if (pathname === "/api/stats") {
          return json(handleStats(data, url.searchParams));
        }
        if (pathname === "/api/worker") {
          return json(handleWorkerStatus(data));
        }
        if (pathname === "/api/logs") {
          return json(handleLogs(data, url.searchParams));
        }
        return json({ status: 404, body: { error: "not found" } });
      }

      if (!uiDir) {
        return new Response(MISSING_UI_PAGE, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      // Static asset, falling back to index.html for SPA routes.
      return (
        serveStatic(uiDir, pathname) ??
        serveStatic(uiDir, "/") ??
        new Response("not found", { status: 404 })
      );
    },
  });

  console.log(`📊 Dashboard running at http://${host}:${port}`);
  console.log(`   Database: ${data.dbPath}${data.dbMissing ? " (not created yet)" : ""}`);
  if (!uiDir) {
    console.log("   UI assets not found — JSON API only (see /api/runs, /api/stats).");
  }

  return server;
}
