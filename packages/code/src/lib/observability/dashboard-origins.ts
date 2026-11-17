/**
 * Dashboard allowed origins: the explicit opt-in list of non-loopback origins
 * (Tailscale Serve, an authenticating reverse proxy) the dashboard API trusts.
 *
 * Entries come from `devintern dashboard --allow-origin`, the
 * `DASHBOARD_ALLOWED_ORIGINS` env var, `[dashboard].allowed_origins` in
 * workspace.toml, and Tailscale Serve auto-detection. Each is parsed once,
 * here, into a {@link DashboardAllowedOrigin}.
 */

const LOOPBACK_DASHBOARD_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Whether a host name is a supported loopback name (brackets and case ignored). */
export function isLoopbackDashboardHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return LOOPBACK_DASHBOARD_HOSTS.has(normalized);
}

/** Where an allowed origin came from (for startup logs and warnings). */
export type DashboardAllowedOriginSource = "explicit" | "tailscale-serve" | "tailscale-funnel";

/** One trusted non-loopback origin, normalized. */
export interface DashboardAllowedOrigin {
  /** Exact `Origin` a browser sends for writes, e.g. `https://box.tailnet.ts.net`. */
  origin: string;
  /** `Host` header it arrives with; default ports are omitted, e.g. `box.tailnet.ts.net`. */
  host: string;
  /** `http:` or `https:`. */
  scheme: "http:" | "https:";
  source: DashboardAllowedOriginSource;
}

/** Result of parsing a single allowed-origin entry. */
export type DashboardAllowedOriginParse =
  | { ok: true; value: DashboardAllowedOrigin }
  | { ok: false; error: string };

/**
 * Parse one `scheme://host[:port]` entry. Case and a trailing slash are
 * normalized; paths, queries, fragments, userinfo, wildcards, and
 * non-http(s) schemes are rejected.
 */
export function parseDashboardAllowedOrigin(
  entry: string,
  source: DashboardAllowedOriginSource = "explicit",
): DashboardAllowedOriginParse {
  const trimmed = entry.trim().replace(/\/$/, "");
  const invalid = (reason: string): DashboardAllowedOriginParse => ({
    ok: false,
    error: `invalid dashboard allowed origin "${entry}": ${reason} (expected scheme://host[:port], e.g. https://box.tailnet.ts.net)`,
  });
  if (!trimmed) return invalid("empty");
  if (trimmed.includes("*")) return invalid("wildcards are not supported");
  if (!/^https?:\/\//i.test(trimmed)) return invalid("scheme must be http:// or https://");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return invalid("not a URL");
  }
  if (parsed.username || parsed.password) return invalid("userinfo is not allowed");
  if (parsed.pathname !== "/" || /^https?:\/\/[^/]+\//i.test(trimmed)) {
    return invalid("paths are not allowed");
  }
  if (parsed.search || parsed.hash || trimmed.includes("?") || trimmed.includes("#")) {
    return invalid("query strings and fragments are not allowed");
  }
  if (!parsed.hostname) return invalid("missing host");
  return {
    ok: true,
    value: {
      origin: parsed.origin,
      host: parsed.host,
      scheme: parsed.protocol === "https:" ? "https:" : "http:",
      source,
    },
  };
}

/**
 * Parse a list of entries, collecting one error per malformed entry.
 *
 * @param entries - Raw entries (already split)
 * @param label - Where they came from, prefixed to each error
 */
export function parseDashboardAllowedOriginList(
  entries: readonly string[],
  label: string,
): { origins: DashboardAllowedOrigin[]; errors: string[] } {
  const origins: DashboardAllowedOrigin[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    const result = parseDashboardAllowedOrigin(entry);
    if (result.ok) origins.push(result.value);
    else errors.push(`${label}: ${result.error}`);
  }
  return { origins, errors };
}

/** Parse the comma-separated `DASHBOARD_ALLOWED_ORIGINS` value (unset/blank → empty). */
export function parseDashboardAllowedOriginsEnv(value: string | undefined): {
  origins: DashboardAllowedOrigin[];
  errors: string[];
} {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parseDashboardAllowedOriginList(entries, "DASHBOARD_ALLOWED_ORIGINS");
}

/**
 * Whether `DASHBOARD_TAILSCALE_AUTODETECT` disables detection. Unset means
 * enabled; `0`, `false`, `no`, and `off` disable it.
 */
export function isDashboardTailscaleAutodetectDisabledByEnv(value: string | undefined): boolean {
  return ["0", "false", "no", "off"].includes((value ?? "").trim().toLowerCase());
}

/** Merge lists, keeping the first entry for each origin. */
export function mergeDashboardAllowedOrigins(
  ...lists: readonly (readonly DashboardAllowedOrigin[])[]
): DashboardAllowedOrigin[] {
  const seen = new Map<string, DashboardAllowedOrigin>();
  for (const list of lists) {
    for (const entry of list) {
      if (!seen.has(entry.origin)) seen.set(entry.origin, entry);
    }
  }
  return [...seen.values()];
}

/**
 * Whether a request `Host` (lowercased) is the one this origin arrives with.
 * An explicit default port (`box.ts.net:443` for https) also matches.
 */
export function dashboardOriginMatchesHost(entry: DashboardAllowedOrigin, host: string): boolean {
  if (host === entry.host) return true;
  const hasPort = /(\]|^[^[]*):\d+$/.test(entry.host);
  const defaultPort = entry.scheme === "https:" ? "443" : "80";
  return !hasPort && host === `${entry.host}:${defaultPort}`;
}
