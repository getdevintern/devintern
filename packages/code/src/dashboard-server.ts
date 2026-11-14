import { readRunArtifactFile } from "./lib/observability/task-artifacts";
/**
 * Dashboard Server
 *
 * Serves the local observability dashboard: a read-only JSON API over the
 * worker's SQLite state (handlers in `lib/dashboard-api.ts`) plus the static
 * UI built from `packages/dashboard-ui`. Started standalone by
 * `devintern dashboard`, or alongside the daemon by `devintern worker`.
 *
 * All data stays in the customer's SQLite. The dashboard uses the loopback
 * interface as its access boundary and refuses non-loopback binds.
 */

import { existsSync } from "fs";
import { join, normalize, resolve } from "path";

import {
  DashboardData,
  handleAgentPrs,
  handleAutomations,
  handleLogs,
  handleRetryRun,
  handleRunArtifact,
  handleRunArtifacts,
  handleRunAutomation,
  handleRunHarnessLog,
  handleRunHarnessLogs,
  handleRuns,
  handleRunDetail,
  handleStats,
  handleWorkerStatus,
} from "./lib/observability/dashboard-api";
import { handleOverview } from "./lib/observability/dashboard-overview";
import { handleWorkspace } from "./lib/observability/dashboard-workspace";
import type { AutomationRunDeps, RetryHandlerDeps } from "./lib/observability/dashboard-api";
import type { DashboardAutomationActions } from "./lib/automation/acquirer";
import {
  dashboardOriginMatchesHost,
  isDashboardTailscaleAutodetectDisabledByEnv,
  isLoopbackDashboardHost,
  mergeDashboardAllowedOrigins,
  parseDashboardAllowedOriginsEnv,
} from "./lib/observability/dashboard-origins";
import type { DashboardAllowedOrigin } from "./lib/observability/dashboard-origins";
import { TailscaleOriginDetector } from "./lib/observability/dashboard-tailscale";
import type { TailscaleStatusProbe } from "./lib/observability/dashboard-tailscale";

export const DEFAULT_DASHBOARD_PORT = 4400;
export { isLoopbackDashboardHost };

/** Why {@link checkDashboardRequest} refused a request. */
export interface DashboardRequestRejection {
  status: 403 | 415;
  /** `host`: the Host is neither loopback nor allowlisted (worth a re-detection). */
  reason: "host" | "origin" | "content-type";
  error: string;
}

export interface DashboardRequestGuardOptions {
  /** Trusted non-loopback origins (explicit and auto-detected). */
  allowedOrigins?: readonly DashboardAllowedOrigin[];
}

/** Parse a `Host` header into its lowercased authority, or null when malformed. */
function parseHostHeader(header: string | null): { host: string; hostname: string } | null {
  if (!header || /[/@?#\s]/.test(header)) return null;
  let parsed: URL;
  try {
    parsed = new URL(`http://${header}`);
  } catch {
    return null;
  }
  return { host: parsed.host, hostname: parsed.hostname };
}

/**
 * Central CSRF / DNS-rebinding guard for every `/api` request.
 *
 * Host (every method, GET included, because rebinding can read):
 * - a loopback name (`127.0.0.1`, `localhost`, `[::1]`) on ANY port is
 *   accepted. A DNS-rebinding page cannot make a browser send a loopback Host
 *   (the Host is the attacker's own name), and a remapped port (an SSH tunnel
 *   on `localhost:8440`) is still the user's own machine;
 * - otherwise the Host must belong to an allowed origin (explicit
 *   `allowed_origins` or a detected Tailscale Serve name), else 403.
 *
 * Writes (non-GET/HEAD):
 * - `Origin` must be the origin of the request's own Host: `http://<Host>`
 *   for a loopback Host, or the allowed origin whose Host matched. A page on
 *   another localhost port can neither read the API (same-origin policy, no
 *   CORS headers) nor write it (its Origin is not this Host). An allowed
 *   origin is also accepted on a loopback Host, for proxies that rewrite Host
 *   to the upstream address. A missing `Origin` passes only with
 *   `Sec-Fetch-Site: same-origin`. Otherwise 403;
 * - `Content-Type` must start with `application/json`, which a cross-origin
 *   page cannot send without a CORS preflight the server never approves,
 *   else 415.
 *
 * `X-Forwarded-*` headers are never consulted.
 *
 * @param request - Incoming request
 * @param options - Allowed non-loopback origins
 * @returns null when the request may proceed, else the rejection to send
 */
export function checkDashboardRequest(
  request: Request,
  options: DashboardRequestGuardOptions = {},
): DashboardRequestRejection | null {
  const allowedOrigins = options.allowedOrigins ?? [];
  const host = parseHostHeader(request.headers.get("host"));
  const loopback = host !== null && isLoopbackDashboardHost(host.hostname);
  const hostMatches = host
    ? allowedOrigins.filter((entry) => dashboardOriginMatchesHost(entry, host.host))
    : [];
  if (!host || (!loopback && hostMatches.length === 0)) {
    return {
      status: 403,
      reason: "host",
      error:
        "forbidden host; open the dashboard via http://localhost:<port> or http://127.0.0.1:<port>, " +
        "or add its origin to [dashboard].allowed_origins",
    };
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  const origin = request.headers.get("origin");
  if (origin === null) {
    if (request.headers.get("sec-fetch-site") !== "same-origin") {
      return { status: 403, reason: "origin", error: "forbidden: missing Origin header" };
    }
  } else {
    const trusted = loopback
      ? origin === `http://${host.host}` || allowedOrigins.some((entry) => entry.origin === origin)
      : hostMatches.some((entry) => entry.origin === origin);
    if (!trusted) {
      return { status: 403, reason: "origin", error: "forbidden: cross-origin request" };
    }
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return {
      status: 415,
      reason: "content-type",
      error: "unsupported media type: expected application/json",
    };
  }
  return null;
}

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  /** Database owning run history (defaults to the project-scoped worker DB). */
  dbPath?: string;
  /**
   * Database owning durable queue counts (ad-hoc tasks, scheduled retries).
   * Defaults to `dbPath` when supplied, else the configured workspace DB.
   */
  queueDbPath?: string;
  /** Project root used to locate the worker lock file. */
  workingDir?: string;
  /**
   * Workspace home holding the worker lock, capture files, and harness
   * transcripts (defaults to `resolveWorkspaceDir()`, or `DEVINTERN_WORKSPACE_DIR`).
   */
  workspaceDir?: string;
  /** Live working-window snapshot provider (embedded dashboard). */
  scheduleSnapshot?: () => import("./lib/worker/schedule").ScheduleSnapshot | null;
  /**
   * Retry execution mode (default `spawn`). The workspace worker passes
   * `schedule` so dashboard retries are drained through the fleet pipeline;
   * a standalone `devintern dashboard` keeps the detached-CLI spawn.
   */
  retryMode?: "spawn" | "schedule";
  /** Collaborator overrides for the retry action (tests). */
  retryDeps?: RetryHandlerDeps;
  /**
   * Automation listing/triggering overrides. The workspace worker passes its
   * in-process scheduler so "Run now" rides the exact scheduled pipeline;
   * a standalone dashboard falls back to the project's automations.toml.
   */
  automationActions?: DashboardAutomationActions;
  /** Collaborator overrides for the manual-run action (tests). */
  automationDeps?: AutomationRunDeps;
  /** Directories to search for worker capture files (primary first). */
  logDirs?: string[];
  /**
   * Explicitly trusted non-loopback origins (`--allow-origin`,
   * `[dashboard].allowed_origins`); merged with `DASHBOARD_ALLOWED_ORIGINS`.
   */
  allowedOrigins?: readonly DashboardAllowedOrigin[];
  /**
   * Trust names `tailscale serve` proxies to this dashboard (default true).
   * `DASHBOARD_TAILSCALE_AUTODETECT=0` also disables it.
   */
  tailscaleAutodetect?: boolean;
  /** Replacement for `tailscale serve status --json` (tests). */
  tailscaleProbe?: TailscaleStatusProbe;
}

/** Log trusted origins and the access warning they carry. */
function logAllowedOrigins(origins: readonly DashboardAllowedOrigin[], label: string): void {
  if (origins.length === 0) return;
  console.log(`   ${label}: ${origins.map((entry) => entry.origin).join(", ")}`);
  console.warn(
    "   ⚠️  Anyone who can reach these addresses gets full dashboard access, including retries and automation runs.",
  );
  const funnel = origins.filter((entry) => entry.source === "tailscale-funnel");
  if (funnel.length > 0) {
    console.warn(
      `   🚨 Tailscale Funnel publishes ${funnel.map((entry) => entry.origin).join(", ")} on the PUBLIC INTERNET ` +
        "with no login: anyone on the internet can read run transcripts and trigger work. " +
        "Run `tailscale funnel reset` or set DASHBOARD_TAILSCALE_AUTODETECT=0.",
    );
  }
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
  "The JSON API is available under /api (try /api/overview, /api/runs, /api/stats, /api/worker).\n" +
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
  if (!isLoopbackDashboardHost(host)) {
    throw new Error(
      `Dashboard host "${host}" is not loopback. ` +
        "Remote dashboard access is disabled until request authentication is implemented; " +
        "use 127.0.0.1, localhost, or ::1.",
    );
  }
  const data = new DashboardData({
    dbPath: options.dbPath,
    queueDbPath: options.queueDbPath,
    workingDir: options.workingDir,
    workspaceDir: options.workspaceDir,
    scheduleSnapshot: options.scheduleSnapshot,
    retryMode: options.retryMode,
    automationActions: options.automationActions,
    logDirs: options.logDirs,
  });
  const uiDir = resolveUiDir();

  const runDetailPattern = /^\/api\/runs\/([^/]+)$/;
  const runHarnessLogsPattern = /^\/api\/runs\/([^/]+)\/harness-logs$/;
  const runHarnessLogPattern = /^\/api\/runs\/([^/]+)\/harness-logs\/([^/]+)$/;
  const runArtifactsPattern = /^\/api\/runs\/([^/]+)\/artifacts$/;
  const runArtifactFilePattern = /^\/api\/runs\/([1-9][0-9]*)\/artifacts\/([a-f0-9-]{36})\/file$/;
  const runArtifactPattern = /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/;
  const runRetryPattern = /^\/api\/runs\/([^/]+)\/retry$/;
  const automationRunPattern = /^\/api\/automations\/([^/]+)\/run$/;

  const envOrigins = parseDashboardAllowedOriginsEnv(process.env.DASHBOARD_ALLOWED_ORIGINS);
  if (envOrigins.errors.length > 0) {
    throw new Error(envOrigins.errors.join("\n"));
  }
  const explicitOrigins = mergeDashboardAllowedOrigins(
    options.allowedOrigins ?? [],
    envOrigins.origins,
  );
  const tailscaleAutodetect =
    (options.tailscaleAutodetect ?? true) &&
    !isDashboardTailscaleAutodetectDisabledByEnv(process.env.DASHBOARD_TAILSCALE_AUTODETECT);
  // Assigned once the bound port is known (port 0 binds an ephemeral one).
  let tailscale: TailscaleOriginDetector | null = null;
  const guard = (request: Request) =>
    checkDashboardRequest(request, {
      allowedOrigins: tailscale
        ? mergeDashboardAllowedOrigins(explicitOrigins, tailscale.current)
        : explicitOrigins,
    });

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname.startsWith("/api")) {
        // Central CSRF / DNS-rebinding guard; must stay ahead of every route.
        let rejection = guard(request);
        if (rejection?.reason === "host" && tailscale) {
          // An unknown Host may be a `tailscale serve` added after startup:
          // re-detect (rate limited) before refusing.
          await tailscale.refreshIfStale();
          rejection = guard(request);
        }
        if (rejection) {
          return json({ status: rejection.status, body: { error: rejection.error } });
        }
        const retry = request.method === "POST" ? pathname.match(runRetryPattern) : null;
        if (retry) {
          return json(await handleRetryRun(data, retry[1], options.retryDeps));
        }
        const automationRun =
          request.method === "POST" ? pathname.match(automationRunPattern) : null;
        if (automationRun) {
          return json(await handleRunAutomation(data, automationRun[1], options.automationDeps));
        }
        if (request.method !== "GET") {
          return json({ status: 405, body: { error: "method not allowed" } });
        }
        if (pathname === "/api/health") {
          return json({ status: 200, body: { status: "ok" } });
        }
        if (pathname === "/api/automations") {
          return json(handleAutomations(data));
        }
        if (pathname === "/api/task-activity") {
          return json({ status: 200, body: data.getTaskActivity() });
        }
        if (pathname === "/api/runs") {
          return json(handleRuns(data, url.searchParams));
        }
        const harnessLogs = pathname.match(runHarnessLogsPattern);
        if (harnessLogs) {
          return json(handleRunHarnessLogs(data, harnessLogs[1]));
        }
        const harnessLog = pathname.match(runHarnessLogPattern);
        if (harnessLog) {
          return json(handleRunHarnessLog(data, harnessLog[1], harnessLog[2]));
        }
        const artifacts = pathname.match(runArtifactsPattern);
        if (artifacts) {
          return json(handleRunArtifacts(data, artifacts[1]));
        }
        const artifactFile = pathname.match(runArtifactFilePattern);
        if (artifactFile)
          return readRunArtifactFile(
            data.dbPath,
            Number(artifactFile[1]),
            artifactFile[2],
            url.searchParams.has("download"),
          );
        const artifact = pathname.match(runArtifactPattern);
        if (artifact) {
          return json(handleRunArtifact(data, artifact[1], artifact[2]));
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
        if (pathname === "/api/overview") {
          return json(handleOverview(data));
        }
        if (pathname === "/api/workspace") {
          return json(handleWorkspace(data));
        }
        if (pathname === "/api/agent-prs") {
          return json(handleAgentPrs(data));
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
  if (data.queueDbPath !== data.dbPath) {
    console.log(
      `   Queue database: ${data.queueDbPath}${existsSync(data.queueDbPath) ? "" : " (not created yet)"}`,
    );
  }
  if (!uiDir) {
    console.log("   UI assets not found — JSON API only (see /api/runs, /api/stats).");
  }
  logAllowedOrigins(explicitOrigins, "Allowed origins");
  if (tailscaleAutodetect) {
    tailscale = new TailscaleOriginDetector({
      boundPort: server.port ?? port,
      probe: options.tailscaleProbe,
      onChange: (origins) => {
        if (origins.length > 0)
          logAllowedOrigins(origins, "Tailscale Serve origins (auto-detected)");
        else console.log("   Tailscale Serve no longer proxies to this dashboard.");
      },
    });
    // Fire-and-forget: detection never delays or fails startup.
    void tailscale.refresh();
  }

  return server;
}
