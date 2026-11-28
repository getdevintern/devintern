/**
 * Setup-wizard credentials that stay in the main process.
 *
 * The renderer gets tracker settings it displays (base URL, email, project
 * key) and only the names of available secrets (tokens, API keys, PATs). On
 * probe and save the main process reads the secrets again, from DevIntern
 * Code's credentials or the project's `.devintern-pm/.env`, and fills each one
 * the user left blank. A value the user typed always wins.
 *
 * A reused secret is filled only for the project the main process has loaded
 * and only when the request keeps the source's host settings (see
 * `sameTrackerHost`), so a renderer cannot send a stored token elsewhere.
 */

import { resolve } from "node:path";

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
import { sameTrackerHost } from "../shared/reuse-host.ts";
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
 * Keep only the wizard step keys of `trackerId`. Anything else the renderer
 * sends is dropped, because saving sets `process.env` and some keys there
 * choose the API host (`LINEAR_API_URL`, `TRELLO_API_BASE_URL`,
 * `ASANA_API_BASE_URL`) or other main-process behavior (`AGENT_CLI_PATH`).
 */
function trackerStepValues(
  trackerId: string,
  values: Record<string, string>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const step of PM_TRACKER_SETUP[trackerId] ?? []) {
    const value = values[step.key];
    if (typeof value === "string") picked[step.key] = value;
  }
  return picked;
}

/**
 * Fill each secret of `trackerId` left blank in `values` from `reuse`.
 *
 * @returns only the tracker's step keys; secrets left blank unless `reuse` is
 *   given and `values` keep the source's host (else the user must type them)
 */
export async function fillReusedSecrets(
  trackerId: string,
  rawValues: Record<string, string>,
  reuse: ReusedSecretsRequest | undefined,
): Promise<Record<string, string>> {
  const values = trackerStepValues(trackerId, rawValues);
  if (!reuse) return values;
  const source = await readReusableSecrets(trackerId, reuse);
  if (!sameTrackerHost(trackerId, values, source)) return values;
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

/**
 * Reject a reuse request for any folder but the project the main process has
 * loaded (`activeProjectDir`), which is the one the setup wizard is open for.
 *
 * @throws `invalid_input` when the folders differ
 */
export function assertReuseForActiveProject(
  reuseProjectDir: string,
  activeProjectDir: string | null,
): void {
  if (activeProjectDir && resolve(reuseProjectDir) === resolve(activeProjectDir)) return;
  throw Object.assign(new Error("Credential reuse is only available for the open project."), {
    code: "invalid_input",
  });
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
