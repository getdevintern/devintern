/**
 * "Start the worker once signed in": `worker init --non-interactive --start`
 * records it when signing in is the only step left, and the next completed
 * `worker login` (within the pending sign-in's lifetime) installs and starts
 * the service, then forgets it. A later `worker init` that does not ask for
 * it again, or `worker service uninstall`, forgets it too.
 *
 * The same file remembers a `--no-relay` choice (`start: false`) when setup
 * did not also request `--start`: the completing login then skips pairing but
 * starts no service. That intent counts only for the pending sign-in setup
 * reported: a login completing a sign-in that began after it ignores it.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { PENDING_LOGIN_TTL_MS } from "@devintern/auth";

import { workspaceCodeStateDir } from "../workspace/paths";

/** The recorded intent (owner-only file under the workspace state). */
export interface WorkerStartIntent {
  /** ISO timestamp of the `worker init` run that recorded it. */
  requestedAt: string;
  /** False when that run passed `--no-relay`: the sign-in then skips relay pairing too. */
  relay: boolean;
  /**
   * Whether the completing sign-in should install and start the service.
   * Absent (or true) for a `worker init --start`; false when only the
   * `--no-relay` choice is remembered for the completing sign-in.
   */
  start?: boolean;
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

/**
 * How long a recorded intent counts: as long as the pending sign-in that
 * `worker init --sign-in` started. A later, unrelated login does not start
 * a service.
 */
export const WORKER_START_INTENT_TTL_MS = PENDING_LOGIN_TTL_MS;

/** The recorded intent, or null when there is none, it expired, or it is unreadable. */
export function loadWorkerStartIntent(
  workspaceDir: string,
  now: number = Date.now(),
): WorkerStartIntent | null {
  try {
    const data = JSON.parse(readFileSync(workerStartIntentPath(workspaceDir), "utf8")) as {
      requestedAt?: unknown;
      relay?: unknown;
      start?: unknown;
    };
    if (typeof data.requestedAt !== "string") return null;
    const requestedAt = Date.parse(data.requestedAt);
    if (!Number.isFinite(requestedAt) || now - requestedAt > WORKER_START_INTENT_TTL_MS)
      return null;
    return {
      requestedAt: data.requestedAt,
      relay: data.relay !== false,
      // Older intents only ever meant "start the service".
      start: data.start !== false,
    };
  } catch {
    return null;
  }
}

/** Forget the intent. */
export function clearWorkerStartIntent(workspaceDir: string): void {
  rmSync(workerStartIntentPath(workspaceDir), { force: true });
}
