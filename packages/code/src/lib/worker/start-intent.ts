/**
 * "Start the worker once signed in": `worker init --non-interactive --start`
 * records it when signing in is the only step left, and the next completed
 * `worker login` installs and starts the service, then forgets it.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { workspaceCodeStateDir } from "../workspace/paths";

/** The recorded intent (owner-only file under the workspace state). */
export interface WorkerStartIntent {
  /** ISO timestamp of the `worker init --start` run that recorded it. */
  requestedAt: string;
  /** False when that run passed `--no-relay`: the sign-in then skips relay pairing too. */
  relay: boolean;
}

/** Where the intent is stored. */
export function workerStartIntentPath(workspaceDir: string): string {
  return join(workspaceCodeStateDir(workspaceDir), "start-after-sign-in.json");
}

/** Record the intent, replacing an older one. */
export function saveWorkerStartIntent(workspaceDir: string, intent: WorkerStartIntent): void {
  const path = workerStartIntentPath(workspaceDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(intent, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The recorded intent, or null when there is none (or it is unreadable). */
export function loadWorkerStartIntent(workspaceDir: string): WorkerStartIntent | null {
  try {
    const data = JSON.parse(readFileSync(workerStartIntentPath(workspaceDir), "utf8")) as {
      requestedAt?: unknown;
      relay?: unknown;
    };
    if (typeof data.requestedAt !== "string") return null;
    return { requestedAt: data.requestedAt, relay: data.relay !== false };
  } catch {
    return null;
  }
}

/** Forget the intent. */
export function clearWorkerStartIntent(workspaceDir: string): void {
  rmSync(workerStartIntentPath(workspaceDir), { force: true });
}
