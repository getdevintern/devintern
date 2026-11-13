/**
 * Hosted relay E2E configuration.
 *
 * Relay tests use the deployed control plane and a real signed-in Supabase
 * session. Local runs default to the active worker session under
 * `~/.devintern`; CI must provide an explicit session path.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_RELAY_URL = "https://relay.devintern.com";

export const defaultRelaySessionPath = join(
  homedir(),
  ".devintern",
  "state",
  "code",
  ".auth-session.json",
);

export interface RelayE2EConfig {
  relayUrl: string;
  sessionPath: string;
}

function isCI(env: Record<string, string | undefined>): boolean {
  return Boolean(env.CI && env.CI !== "0" && env.CI !== "false") || env.GITHUB_ACTIONS === "true";
}

export function resolveRelayE2EConfig(
  env: Record<string, string | undefined> = process.env,
): RelayE2EConfig {
  const relayUrl = (env.E2E_RELAY_URL?.trim() || DEFAULT_RELAY_URL).replace(/\/+$/, "");
  const explicitSession = env.E2E_RELAY_AUTH_SESSION?.trim();
  if (isCI(env) && !explicitSession) {
    throw new Error(
      "CI requires E2E_RELAY_AUTH_SESSION to point at a signed-in Supabase session file",
    );
  }
  const sessionPath = explicitSession ?? defaultRelaySessionPath;
  if (!existsSync(sessionPath)) {
    throw new Error(
      `Missing relay auth session at ${sessionPath}. Run \`devintern login\` or set E2E_RELAY_AUTH_SESSION.`,
    );
  }
  return { relayUrl, sessionPath };
}
