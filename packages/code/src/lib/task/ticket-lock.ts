/**
 * Per-ticket locks shared by manual runs and worker task runs.
 *
 * Both run through the CLI entrypoint with a workspace, so each takes
 * `<workspace>/locks/tasks/<ticket>.lock` before touching the ticket. A manual
 * run on a ticket the worker is processing (or the reverse) is refused instead
 * of both updating the same tracker ticket and branch at once. Work on
 * different tickets of one repository is never blocked.
 */

import { createHash } from "crypto";
import { realpathSync } from "fs";
import { join, resolve } from "path";

import { LockManager } from "../lock-manager";
import { locksDir } from "../workspace/paths";

/** A set of held locks released together. */
export interface HeldLocks {
  release(): void;
}

/** Directory holding per-ticket locks. */
export function ticketLocksDir(workspaceDir: string): string {
  return join(locksDir(workspaceDir), "tasks");
}

/** Directory holding per-checkout locks for manual runs in a workspace. */
export function checkoutLocksDir(workspaceDir: string): string {
  return join(locksDir(workspaceDir), "checkouts");
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Lock file name for a ticket. Tracker keys are case-insensitive, so they are
 * upper-cased; anything else (a markdown task file path, a key with
 * separators) is named by a hash of its resolved form.
 */
export function ticketLockFileName(taskKey: string, isFilePath = false): string {
  if (!isFilePath && SAFE_KEY.test(taskKey)) return `${taskKey.toUpperCase()}.lock`;
  const identity = isFilePath ? resolve(taskKey) : taskKey;
  return `task-${shortHash(identity)}.lock`;
}

/** Lock file name for a checkout directory (by its real path). */
export function checkoutLockFileName(checkoutDir: string): string {
  let real = resolve(checkoutDir);
  try {
    real = realpathSync(real);
  } catch {
    // Keep the resolved path when it cannot be canonicalized.
  }
  return `${shortHash(real)}.lock`;
}

/** Result of {@link acquireTicketLocks}. */
export type TicketLockResult =
  | { ok: true; locks: HeldLocks }
  | { ok: false; taskKey: string; message: string; pid?: number };

/**
 * Take the lock for every ticket, all or nothing.
 *
 * @param tickets - Ticket keys (or markdown task file paths, flagged)
 * @param workspaceDir - Workspace home
 */
export function acquireTicketLocks(
  tickets: Array<{ key: string; isFilePath?: boolean }>,
  workspaceDir: string,
): TicketLockResult {
  const held: LockManager[] = [];
  const release = () => {
    for (const lock of held.splice(0)) lock.release();
  };
  const seen = new Set<string>();
  for (const ticket of tickets) {
    const fileName = ticketLockFileName(ticket.key, ticket.isFilePath);
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    const lock = new LockManager(ticketLocksDir(workspaceDir), fileName);
    const result = lock.acquire();
    if (!result.success) {
      release();
      return {
        ok: false,
        taskKey: ticket.key,
        message:
          result.pid === undefined
            ? `${ticket.key} is already being processed by another devintern run (${result.message})`
            : `${ticket.key} is already being processed by another devintern run (PID: ${result.pid})`,
        ...(result.pid === undefined ? {} : { pid: result.pid }),
      };
    }
    held.push(lock);
  }
  return { ok: true, locks: { release } };
}

/** Release several lock holders together, ignoring absent ones. */
export function combineLocks(...holders: Array<HeldLocks | null | undefined>): HeldLocks {
  return {
    release() {
      for (const holder of holders) holder?.release();
    },
  };
}
