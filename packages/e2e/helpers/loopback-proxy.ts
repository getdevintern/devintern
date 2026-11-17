/**
 * Keep the suite's own loopback fixture fetches away from an ambient HTTP proxy.
 *
 * Workers and CI sandboxes commonly export `HTTP_PROXY`/`HTTPS_PROXY` with
 * `NO_PROXY=localhost,127.0.0.1,::1`. Bun (seen on 1.4.2) does not match the
 * bare `::1` entry against the bracketed `[::1]` host of `http://[::1]:<port>`,
 * so a health poll against an IPv6 loopback fixture is sent to the proxy and
 * fails (502, or a connection error for a dead proxy) even though the server is
 * listening. Adding the bracketed `[::1]` form makes Bun bypass the proxy.
 *
 * Proxy variables are deliberately left alone: suites that reach remote
 * endpoints may legitimately need them. Only the bypass list is extended.
 *
 * Bun reads the bypass list on every request and the lowercase `no_proxy`
 * takes precedence over `NO_PROXY`, so both spellings are kept in sync.
 */

/** Loopback hosts the suite binds fixtures to, in every spelling Bun matches. */
export const LOOPBACK_NO_PROXY_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"] as const;

const NO_PROXY_KEYS = ["no_proxy", "NO_PROXY"] as const;

/** Split a comma-separated bypass list into trimmed, non-empty entries. */
function parseNoProxy(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Return `value` with any missing loopback host appended, preserving the
 * existing entries and their order. Matching is case-insensitive.
 */
export function withLoopbackNoProxy(value: string | undefined): string {
  const entries = parseNoProxy(value);
  const present = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const host of LOOPBACK_NO_PROXY_HOSTS) {
    if (!present.has(host)) entries.push(host);
  }
  return entries.join(",");
}

/**
 * Ensure `env` bypasses any configured proxy for loopback hosts, IPv6 included.
 *
 * Idempotent. When only one spelling is set, the other is seeded from it so
 * neither precedence order can drop the user's existing remote exclusions.
 * Child processes spawned with this env inherit the same bypass list.
 */
export function ensureLoopbackBypassesProxy(
  env: Record<string, string | undefined> = process.env,
): void {
  const fallback = env.no_proxy ?? env.NO_PROXY;
  for (const key of NO_PROXY_KEYS) {
    env[key] = withLoopbackNoProxy(env[key] ?? fallback);
  }
}
