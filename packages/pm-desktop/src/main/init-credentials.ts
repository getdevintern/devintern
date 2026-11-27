/**
 * Setup-wizard credentials that stay in the main process.
 *
 * The renderer gets tracker settings it displays (base URL, email, project
 * key) and only the names of available secrets (tokens, API keys, PATs). On
 * probe and save the main process reads the secrets again, from DevIntern
 * Code's credentials or the project's `.devintern-pm/.env`, and fills each one
 * the user left blank. A value the user typed always wins.
 */

import {
  PM_TRACKER_SETUP,
  inspectPmInitContext,
  listPmTrackers,
  pmTrackerSecretKeys,
  probePmConnection,
  writePmProjectConfig,
} from "@getdevintern/pm/init";
import type { ExistingTrackerConfig } from "@getdevintern/pm/init";
import type {
  ProbeConnectionResult,
  ProjectInitInspect,
  RedactedTrackerConfig,
  ReusedSecretsRequest,
} from "../shared/ipc-contract.ts";
import { persistTrackerCredentials, readProjectEnv } from "./project-env.ts";

type ProbeFn = NonNullable<Parameters<typeof probePmConnection>[2]>;

/** Step keys of every tracker, split by whether their value is a secret. */
function stepKeys(): { secret: Set<string>; plain: Set<string> } {
  const secret = new Set<string>();
  const plain = new Set<string>();
  for (const steps of Object.values(PM_TRACKER_SETUP)) {
    for (const step of steps) (step.secret ? secret : plain).add(step.key);
  }
  return { secret, plain };
}

function redactTrackerConfig(config: ExistingTrackerConfig): RedactedTrackerConfig {
  const secret = new Set(pmTrackerSecretKeys(config.trackerId));
  const values: Record<string, string> = {};
  const secretKeys: string[] = [];
  for (const [key, value] of Object.entries(config.values)) {
    if (secret.has(key)) secretKeys.push(key);
    else values[key] = value;
  }
  return { trackerId: config.trackerId, values, secretKeys };
}

/**
 * Keep `TASK_TRACKER` and known non-secret tracker settings; list secret
 * tracker keys by name. Anything else in the env file is dropped (the wizard
 * does not need it, and an unknown key could hold a secret).
 */
function redactProjectEnv(env: Record<string, string>): {
  currentEnv: Record<string, string>;
  currentSecretKeys: string[];
} {
  const { secret, plain } = stepKeys();
  const currentEnv: Record<string, string> = {};
  const currentSecretKeys: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (key === "TASK_TRACKER" || plain.has(key)) currentEnv[key] = value;
    else if (secret.has(key) && value.trim()) currentSecretKeys.push(key);
  }
  return { currentEnv, currentSecretKeys };
}

/** The setup wizard's inspect payload, with no secret values in it. */
export async function inspectProjectInitForRenderer(dir: string): Promise<ProjectInitInspect> {
  const context = await inspectPmInitContext(dir);
  const { env } = await readProjectEnv(dir);
  return {
    ...context,
    reusableFromCode: context.reusableFromCode
      ? redactTrackerConfig(context.reusableFromCode)
      : null,
    trackers: listPmTrackers(),
    ...redactProjectEnv(env),
  };
}

/** Secrets for `trackerId` from `reuse.source`, looked up now. */
async function readReusableSecrets(
  trackerId: string,
  reuse: ReusedSecretsRequest,
): Promise<Record<string, string>> {
  if (reuse.source === "code") {
    const { reusableFromCode } = await inspectPmInitContext(reuse.projectDir);
    // Never pair one tracker's token with another tracker's settings.
    return reusableFromCode?.trackerId === trackerId ? reusableFromCode.values : {};
  }
  return (await readProjectEnv(reuse.projectDir)).env;
}

/**
 * Fill each secret of `trackerId` left blank in `values` from `reuse`.
 *
 * @returns `values` unchanged without `reuse`
 */
export async function fillReusedSecrets(
  trackerId: string,
  values: Record<string, string>,
  reuse: ReusedSecretsRequest | undefined,
): Promise<Record<string, string>> {
  if (!reuse) return values;
  const source = await readReusableSecrets(trackerId, reuse);
  const filled = { ...values };
  for (const key of pmTrackerSecretKeys(trackerId)) {
    if (!filled[key]?.trim() && source[key]?.trim()) filled[key] = source[key];
  }
  return filled;
}

/**
 * Validate IPC input for {@link ReusedSecretsRequest}.
 *
 * @throws `invalid_input` for anything else
 */
export function parseReusedSecretsRequest(input: unknown): ReusedSecretsRequest | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "object") {
    const { projectDir, source } = input as { projectDir?: unknown; source?: unknown };
    if (
      typeof projectDir === "string" &&
      projectDir.trim() &&
      (source === "code" || source === "project")
    ) {
      return { projectDir, source };
    }
  }
  throw Object.assign(new Error("Invalid credential reuse request."), { code: "invalid_input" });
}

/** Probe tracker credentials, filling reused secrets first. */
export async function probeWithReusedSecrets(
  trackerId: string,
  values: Record<string, string>,
  reuse: ReusedSecretsRequest | undefined,
  probe?: ProbeFn,
): Promise<ProbeConnectionResult> {
  return probePmConnection(trackerId, await fillReusedSecrets(trackerId, values, reuse), probe);
}

/** Write a new `.devintern-pm/.env`, filling DevIntern Code's secrets when reused. */
export async function writeInitialProjectConfig(input: {
  projectDir: string;
  trackerId: string;
  values: Record<string, string>;
  overwrite: boolean;
  reuseFromCode: boolean;
}): Promise<void> {
  const values = await fillReusedSecrets(
    input.trackerId,
    input.values,
    input.reuseFromCode ? { projectDir: input.projectDir, source: "code" } : undefined,
  );
  await writePmProjectConfig({
    cwd: input.projectDir,
    trackerId: input.trackerId,
    values,
    overwrite: input.overwrite,
  });
}

/**
 * Merge a tracker's credentials into `.devintern-pm/.env`. A blank secret
 * keeps its current value, so required secrets the renderer never saw pass
 * validation.
 */
export async function updateTrackerCredentials(
  projectDir: string,
  trackerId: string,
  values: Record<string, string>,
): Promise<void> {
  const filled = await fillReusedSecrets(trackerId, values, { projectDir, source: "project" });
  await persistTrackerCredentials(projectDir, trackerId, filled);
}
