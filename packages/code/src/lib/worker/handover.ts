import { writeFileSync } from "node:fs";

/** Private marker passed only to a worker spawned during an update handover. */
export const WORKER_READY_FILE_ENV_VAR = "DEVINTERN_HANDOVER_READY_FILE";

/** Acknowledge handover only after the worker has started its acquirers. */
export function acknowledgeWorkerHandover(env: NodeJS.ProcessEnv = process.env): void {
  const path = env[WORKER_READY_FILE_ENV_VAR];
  if (!path) return;
  try {
    writeFileSync(path, String(process.pid), { flag: "wx" });
  } catch (error) {
    console.warn(`⚠️  Could not acknowledge worker handover: ${(error as Error).message}`);
  }
  delete env[WORKER_READY_FILE_ENV_VAR];
}
