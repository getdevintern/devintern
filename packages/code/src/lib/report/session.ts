/**
 * Stored-session reader for report submission.
 *
 * Kept free of `@devintern/auth` so the public `@getdevintern/code/report`
 * export remains usable outside a full CLI install. Refreshing an expired
 * token is a CLI concern and lives in `identity.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveReportConfigDir } from "./paths";

export interface ReportIdentity {
  signedIn: boolean;
  accessToken?: string;
  email?: string;
}

interface StoredSession {
  accessToken?: unknown;
  user?: { email?: unknown };
}

/** Read the locally stored session without refreshing it. */
export function readStoredIdentity(configDir?: string): ReportIdentity {
  const dir = resolveReportConfigDir(configDir);
  const path = join(dir, ".auth-session.json");
  if (!existsSync(path)) return { signedIn: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredSession;
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken.trim()) {
      return { signedIn: false };
    }
    const email =
      parsed.user && typeof parsed.user.email === "string" ? parsed.user.email : undefined;
    return {
      signedIn: true,
      accessToken: parsed.accessToken,
      ...(email ? { email } : {}),
    };
  } catch {
    return { signedIn: false };
  }
}
