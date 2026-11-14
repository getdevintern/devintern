/**
 * Tailscale Serve auto-detection for the dashboard's allowed origins.
 *
 * `tailscale serve` proxies `https://<machine>.<tailnet>.ts.net` to the
 * loopback dashboard and forwards the incoming Host unchanged (`r.Out.Host =
 * r.In.Host` in tailscale's ipn/ipnlocal/serve.go), so the dashboard sees a
 * `*.ts.net` Host its loopback-only guard would reject. Instead of making
 * every Tailscale user configure `allowed_origins`, we ask the local
 * tailscaled which names it serves and trust exactly the ones whose handler
 * proxies to this dashboard. DNS rebinding cannot forge that: an attacker
 * cannot make this tailnet's `*.ts.net` name resolve to their server, and the
 * list comes from Tailscale itself, never from request headers.
 */

import { isLoopbackDashboardHost } from "./dashboard-origins";
import type { DashboardAllowedOrigin } from "./dashboard-origins";

/** One `Web` entry of `tailscale serve status --json`. */
export interface TailscaleServeWebEntry {
  /** `host:port` key, e.g. `box.tailnet.ts.net:443`. */
  hostPort: string;
  /** Every handler's `Proxy` target (handlers without one are skipped). */
  proxies: string[];
  /** Whether `AllowFunnel` publishes this entry on the public internet. */
  funnel: boolean;
}

/** The parts of `tailscale serve status --json` the dashboard reads. */
export interface TailscaleServeStatus {
  web: TailscaleServeWebEntry[];
}

/** Runs `tailscale serve status --json`; resolves its stdout, or null on any failure. */
export type TailscaleStatusProbe = () => Promise<string | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse `tailscale serve status --json` output. Unknown fields are ignored;
 * malformed or non-JSON output yields null.
 */
export function parseTailscaleServeStatus(stdout: string): TailscaleServeStatus | null {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(document)) return null;
  const funnelMap = isRecord(document.AllowFunnel) ? document.AllowFunnel : {};
  const webMap = isRecord(document.Web) ? document.Web : {};
  const web: TailscaleServeWebEntry[] = [];
  for (const [hostPort, config] of Object.entries(webMap)) {
    if (!isRecord(config) || !isRecord(config.Handlers)) continue;
    const proxies: string[] = [];
    for (const handler of Object.values(config.Handlers)) {
      if (isRecord(handler) && typeof handler.Proxy === "string" && handler.Proxy.trim()) {
        proxies.push(handler.Proxy.trim());
      }
    }
    web.push({ hostPort, proxies, funnel: funnelMap[hostPort] === true });
  }
  return { web };
}

/**
 * Whether a serve `Proxy` target is this dashboard. Mirrors tailscale's
 * `expandProxyArg`: a bare port means `http://127.0.0.1:<port>`, a scheme-less
 * `host:port` means `http://host:port`.
 */
export function tailscaleProxyTargetsDashboard(proxy: string, boundPort: number): boolean {
  const expanded = /^\d+$/.test(proxy)
    ? `http://127.0.0.1:${proxy}`
    : /^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)
      ? proxy
      : `http://${proxy}`;
  let parsed: URL;
  try {
    parsed = new URL(expanded);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  return isLoopbackDashboardHost(parsed.hostname) && port === boundPort;
}

/** Allowed origins for every serve entry that proxies to this dashboard. */
export function tailscaleOriginsForDashboard(
  status: TailscaleServeStatus,
  boundPort: number,
): DashboardAllowedOrigin[] {
  const origins: DashboardAllowedOrigin[] = [];
  for (const entry of status.web) {
    if (!entry.proxies.some((proxy) => tailscaleProxyTargetsDashboard(proxy, boundPort))) {
      continue;
    }
    const match = /^(.+):(\d+)$/.exec(entry.hostPort);
    const hostname = (match ? match[1] : entry.hostPort).toLowerCase();
    if (!hostname || hostname.includes("/") || hostname.includes("@")) continue;
    const port = match ? match[2] : "443";
    const host = port === "443" ? hostname : `${hostname}:${port}`;
    origins.push({
      origin: `https://${host}`,
      host,
      scheme: "https:",
      source: entry.funnel ? "tailscale-funnel" : "tailscale-serve",
    });
  }
  return origins;
}

/** Default probe: `tailscale serve status --json` with a short timeout. */
export function defaultTailscaleStatusProbe(timeoutMs = 2000): TailscaleStatusProbe {
  return async () => {
    try {
      const child = Bun.spawn(["tailscale", "serve", "status", "--json"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      try {
        const [stdout, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        return exitCode === 0 ? stdout : null;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Binary missing, not executable, or the read failed: no detection.
      return null;
    }
  };
}

/** Minimum interval between on-demand re-detections. */
export const TAILSCALE_REFRESH_INTERVAL_MS = 30_000;

export interface TailscaleOriginDetectorOptions {
  /** Port the dashboard is bound to. */
  boundPort: number;
  probe?: TailscaleStatusProbe;
  /** Clock (tests). */
  now?: () => number;
  refreshIntervalMs?: number;
  /** Called with the detected set whenever a detection changes it. */
  onChange?: (origins: DashboardAllowedOrigin[]) => void;
}

/**
 * Cached Tailscale Serve detection. {@link refresh} runs once at startup;
 * {@link refreshIfStale} re-runs it on demand (an unrecognized Host) at most
 * once per interval, so a serve config added after startup starts working
 * without a restart and a flood of bad requests cannot spawn a process each.
 */
export class TailscaleOriginDetector {
  private origins: DashboardAllowedOrigin[] = [];
  private lastAttemptAt: number | null = null;
  private inFlight: Promise<DashboardAllowedOrigin[]> | null = null;
  private readonly probe: TailscaleStatusProbe;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;

  constructor(private readonly options: TailscaleOriginDetectorOptions) {
    this.probe = options.probe ?? defaultTailscaleStatusProbe();
    this.now = options.now ?? Date.now;
    this.refreshIntervalMs = options.refreshIntervalMs ?? TAILSCALE_REFRESH_INTERVAL_MS;
  }

  /** The last detected set (empty until the first detection finishes). */
  get current(): DashboardAllowedOrigin[] {
    return this.origins;
  }

  /** Detect now (joining one already in flight). Never rejects. */
  refresh(): Promise<DashboardAllowedOrigin[]> {
    if (this.inFlight) return this.inFlight;
    this.lastAttemptAt = this.now();
    this.inFlight = (async () => {
      let next: DashboardAllowedOrigin[] = [];
      try {
        const stdout = await this.probe();
        const status = stdout === null ? null : parseTailscaleServeStatus(stdout);
        next = status ? tailscaleOriginsForDashboard(status, this.options.boundPort) : [];
      } catch {
        next = [];
      }
      const changed =
        JSON.stringify(next.map((entry) => [entry.origin, entry.source])) !==
        JSON.stringify(this.origins.map((entry) => [entry.origin, entry.source]));
      this.origins = next;
      if (changed) this.options.onChange?.(next);
      return next;
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Re-detect unless one ran within the refresh interval; resolves the current set. */
  async refreshIfStale(): Promise<DashboardAllowedOrigin[]> {
    if (this.inFlight) return this.inFlight;
    if (this.lastAttemptAt !== null && this.now() - this.lastAttemptAt < this.refreshIntervalMs) {
      return this.origins;
    }
    return this.refresh();
  }
}
