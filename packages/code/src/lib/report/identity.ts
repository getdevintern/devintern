/**
 * Reporter identity helpers for CLI entry points.
 *
 * Manual reports refresh the Supabase session when possible so an expired
 * token does not silently downgrade a signed-in report. Automatic reports use
 * the stored token without a network round trip (see `session.ts`).
 */

import { join } from "node:path";
import { createDefaultSupabaseAuthConfig, getAuthenticatedUser } from "@devintern/auth";
import { resolveReportConfigDir } from "./paths";
import { readStoredIdentity } from "./session";
import type { ReportIdentity } from "./session";

/**
 * Resolve the reporter identity, refreshing the session when allowed.
 *
 * A refresh failure falls back to the stored token; the endpoint verifies it
 * and returns 401 if it has expired, which the CLI turns into a saved report
 * and a retry hint.
 */
export async function resolveIdentity(
  configDir?: string,
  options: { refresh?: boolean; timeoutMs?: number } = {},
): Promise<ReportIdentity> {
  const stored = readStoredIdentity(configDir);
  if (!stored.signedIn || options.refresh === false) return stored;

  const config = createDefaultSupabaseAuthConfig(
    join(resolveReportConfigDir(configDir), ".auth-session.json"),
  );
  const timeoutMs = options.timeoutMs ?? 4000;
  const refreshed = await Promise.race([
    getAuthenticatedUser(config).catch(() => null),
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    }),
  ]);
  if (!refreshed) return stored;
  return {
    signedIn: true,
    accessToken: refreshed.accessToken,
    ...(refreshed.email ? { email: refreshed.email } : {}),
  };
}
