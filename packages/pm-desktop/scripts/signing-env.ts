/**
 * Resolve electron-builder signing env so packaging never hard-fails without certs.
 *
 * When no macOS signing material is present, CSC_IDENTITY_AUTO_DISCOVERY
 * is forced off so keychain auto-discovery cannot pick an unexpected identity.
 * Callers merge the returned map into process.env before spawning electron-builder.
 */

export type SigningMode = "unsigned" | "mac";

export interface SigningEnvResult {
  mode: SigningMode;
  /** Overlay merged into process.env (includes blank clears for empty CI secrets). */
  env: Record<string, string | undefined>;
  notes: string[];
}

const SIGNING_ENV_KEYS = ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "CSC_IDENTITY"] as const;

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when macOS signing can proceed from env or an explicit identity name. */
export function hasMacSigningCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSet(env.CSC_LINK) || isSet(env.CSC_NAME) || isSet(env.CSC_IDENTITY);
}

/**
 * Build the env overlay for packaging.
 * Does not mutate the caller's env object.
 */
export function resolveSigningEnv(env: NodeJS.ProcessEnv = process.env): SigningEnvResult {
  const mac = hasMacSigningCredentials(env);
  const notes: string[] = [];
  const overlay: Record<string, string | undefined> = {};

  // GitHub Actions injects empty strings for unset secrets — clear those so
  // electron-builder does not treat "" as a certificate path.
  for (const key of SIGNING_ENV_KEYS) {
    if (key in env && !isSet(env[key])) {
      overlay[key] = undefined;
    }
  }

  if (!mac) {
    overlay.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    notes.push("No CSC_LINK / CSC_NAME — packaging unsigned (CSC_IDENTITY_AUTO_DISCOVERY=false).");
    return { mode: "unsigned", env: overlay, notes };
  }

  if (!isSet(env.CSC_IDENTITY_AUTO_DISCOVERY)) {
    overlay.CSC_IDENTITY_AUTO_DISCOVERY = "true";
  }

  notes.push("Signing credentials detected for: mac.");
  return { mode: "mac", env: overlay, notes };
}
