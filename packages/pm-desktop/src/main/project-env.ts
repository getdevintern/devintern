/**
 * Read / update `.devintern-pm/.env` for tracker, project, and harness switching.
 *
 * Persistence keeps the desktop app and `devpm` CLI on the same active
 * tracker, project key, and `AGENT_HARNESS`.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getHarness,
  isHarnessInstalled,
  listHarnesses,
  resolveExecutablePathStrict,
  resolveHarness,
} from "@devintern/agent-harness";
import { findConfigDir, upsertEnvVars } from "@devintern/utils";
import {
  getProjectKeyEnvVar,
  isTrackerConfigured,
  isTrackerId,
  listConfiguredTrackers,
  parseEnvContent,
} from "@devintern/task-trackers";
import type { ConfiguredTracker, TrackerId } from "@devintern/task-trackers";
import { applyPmTrackerDefaults, missingRequiredPmFields } from "@getdevintern/pm/init-shared";

const CONFIG_DIR = ".devintern-pm";

/**
 * Path to `.devintern-pm/.env` under the project (or an ancestor within the git tree).
 *
 * Does not fall through to a plain project `.env` — that file is not PM config.
 */
export function resolvePmEnvPath(projectDir: string): string | null {
  const configDir = findConfigDir({ configDirName: CONFIG_DIR, startDir: projectDir });
  if (!configDir) return null;
  const envPath = join(configDir, ".env");
  return existsSync(envPath) ? envPath : null;
}

export async function readProjectEnv(projectDir: string): Promise<{
  envPath: string | null;
  env: Record<string, string>;
}> {
  const envPath = resolvePmEnvPath(projectDir);
  if (!envPath) {
    return { envPath: null, env: {} };
  }
  const content = await readFile(envPath, "utf8");
  return { envPath, env: parseEnvContent(content) };
}

export async function listConfiguredTrackersForProject(
  projectDir: string,
): Promise<ConfiguredTracker[]> {
  const { env } = await readProjectEnv(projectDir);
  return listConfiguredTrackers(env);
}

export async function upsertProjectEnvVars(
  projectDir: string,
  vars: Record<string, string>,
): Promise<string> {
  const envPath = resolvePmEnvPath(projectDir);
  if (!envPath) {
    throw new Error(`No ${CONFIG_DIR}/.env found under ${projectDir}. Run \`devpm init\` first.`);
  }
  const existing = await readFile(envPath, "utf8");
  const next = upsertEnvVars(existing, vars);
  await writeFile(envPath, next, "utf8");
  // Keep process.env in sync so the next loadConfig sees the new values even
  // if a prior load already populated overlapping keys.
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
  return envPath;
}

/**
 * Persist `TASK_TRACKER` for a configured tracker.
 *
 * @throws When the tracker id is unknown or missing required env vars.
 */
export async function persistActiveTracker(
  projectDir: string,
  trackerId: string,
): Promise<TrackerId> {
  if (!isTrackerId(trackerId)) {
    throw new Error(`Unknown task tracker: ${trackerId}`);
  }
  const { env } = await readProjectEnv(projectDir);
  if (!isTrackerConfigured(trackerId, env)) {
    throw new Error(
      `${trackerId} is not fully configured in ${CONFIG_DIR}/.env. Add its required credentials first.`,
    );
  }
  await upsertProjectEnvVars(projectDir, { TASK_TRACKER: trackerId });
  return trackerId;
}

/**
 * Persist the active project/team/board/repo key for the current tracker.
 *
 * @throws When there is no env file, no active tracker project-key env, or
 *   the key is empty.
 */
export async function persistActiveProject(
  projectDir: string,
  projectKey: string,
  trackerId?: string,
): Promise<{ trackerId: TrackerId; projectKeyEnv: string; projectKey: string }> {
  const trimmed = projectKey.trim();
  if (!trimmed) {
    throw new Error("Project key must not be empty.");
  }

  const { env } = await readProjectEnv(projectDir);
  const activeId = (trackerId ?? env.TASK_TRACKER ?? "jira").toLowerCase();
  if (!isTrackerId(activeId)) {
    throw new Error(`Unknown task tracker: ${activeId}`);
  }

  const projectKeyEnv = getProjectKeyEnvVar(activeId);
  if (!projectKeyEnv) {
    throw new Error(`${activeId} does not support switching remote projects from the UI.`);
  }

  await upsertProjectEnvVars(projectDir, { [projectKeyEnv]: trimmed });
  return { trackerId: activeId, projectKeyEnv, projectKey: trimmed };
}

/**
 * Persist `AGENT_HARNESS` for an installed, resolvable harness.
 *
 * Validates registry membership, CLI install, and path resolution before
 * writing so a failed switch leaves the previous harness active. Clears a
 * sticky `AGENT_CLI_PATH` so a prior agent path cannot attach to the newly
 * selected harness (same rule as CLI explicit `harnessName` selection).
 *
 * @throws When the harness is unknown, not installed, or its CLI path cannot
 *   be resolved.
 */
export async function persistActiveHarness(
  projectDir: string,
  harnessName: string,
): Promise<string> {
  const trimmed = harnessName.trim();
  if (!trimmed) {
    throw new Error("Harness name must not be empty.");
  }

  const harness = getHarness(trimmed);
  if (!harness) {
    const available = listHarnesses()
      .map((h) => `"${h.name}"`)
      .join(", ");
    throw new Error(`Unknown agent harness: "${trimmed}". Available harnesses: ${available}.`);
  }

  if (!isHarnessInstalled(harness)) {
    throw new Error(
      `${harness.displayName} CLI is not installed or not on your PATH. ` +
        `Install it, or set ${harness.name.toUpperCase().replace(/-/g, "_")}_CLI_PATH.`,
    );
  }

  // Fail before writing .env — mirrors loadConfig's strict path check.
  const resolved = resolveHarness({ harnessName: harness.name });
  resolveExecutablePathStrict(resolved.path, resolved.harness.displayName);

  const { env } = await readProjectEnv(projectDir);
  const vars: Record<string, string> = { AGENT_HARNESS: harness.name };
  // Empty value is falsy in resolveHarness; removes sticky global override.
  if (env.AGENT_CLI_PATH) {
    vars.AGENT_CLI_PATH = "";
  }
  await upsertProjectEnvVars(projectDir, vars);
  delete process.env.AGENT_CLI_PATH;

  return harness.name;
}

/**
 * Merge a tracker's credentials into the existing `.devintern-pm/.env` and
 * make it the active tracker — without overwriting unrelated settings or
 * other trackers' credentials.
 *
 * Unlike {@link persistActiveTracker} (which only flips `TASK_TRACKER` for an
 * already-configured tracker), this writes the credential env vars too, so a
 * user can connect a new tracker (or reconfigure an existing one) from the
 * desktop app after init. Optional fields left blank are not written, so
 * existing values for those keys are preserved.
 *
 * @throws When the tracker id is unknown, required fields are missing, or the
 *   env file does not exist.
 */
export async function persistTrackerCredentials(
  projectDir: string,
  trackerId: string,
  values: Record<string, string>,
): Promise<{ envPath: string; trackerId: TrackerId }> {
  if (!isTrackerId(trackerId)) {
    throw new Error(`Unknown task tracker: ${trackerId}`);
  }
  const merged = applyPmTrackerDefaults(trackerId, values);
  const missing = missingRequiredPmFields(trackerId, merged);
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(", ")}`);
  }
  const vars: Record<string, string> = { TASK_TRACKER: trackerId };
  for (const [key, value] of Object.entries(merged)) {
    if (value.trim()) {
      vars[key] = value;
    }
  }
  const envPath = await upsertProjectEnvVars(projectDir, vars);
  return { envPath, trackerId };
}
