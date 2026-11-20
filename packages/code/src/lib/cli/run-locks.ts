/**
 * Locks a CLI task run holds for its lifetime.
 *
 * - A checkout lock stops two runs in one working tree. A run resolved to a
 *   workspace repo keeps it under `<workspace>/locks/checkouts/`, so nothing
 *   is written into the checkout; other runs keep `.devintern-code/.pid.lock`.
 * - Per-ticket locks (`<workspace>/locks/tasks/`) are shared by manual runs
 *   and worker task runs, so the two never work the same ticket at once. A
 *   worker task that finds its ticket locked exits with
 *   {@link WORKTREE_BUSY_EXIT_CODE}, which the worker treats as deferred.
 */

import { isMarkdownFilePath } from "@devintern/task-trackers";

import { isWorkerSubprocess } from "../config/config-dir";
import { LockManager } from "../lock-manager";
import {
  acquireTicketLocks,
  checkoutLockFileName,
  checkoutLocksDir,
  combineLocks,
} from "../task/ticket-lock";
import type { HeldLocks } from "../task/ticket-lock";
import { WORKTREE_BUSY_EXIT_CODE } from "../worker/usage-limit-protocol";
import type { ManualWorkspaceRun } from "../workspace/manual-run";

/**
 * Acquire the checkout lock and the ticket locks, or exit the process.
 *
 * @param taskKeys - Explicit ticket keys or markdown task files of this run
 * @param manualWorkspace - Workspace repo the checkout resolved to, if any
 * @returns Holder that releases every lock taken
 */
export function acquireRunLocks(
  taskKeys: string[],
  manualWorkspace: ManualWorkspaceRun | null,
): HeldLocks {
  const checkoutLock = manualWorkspace
    ? new LockManager(
        checkoutLocksDir(manualWorkspace.workspaceDir),
        checkoutLockFileName(process.cwd()),
        { plainDir: true },
      )
    : new LockManager();
  const lockResult = checkoutLock.acquire();
  if (!lockResult.success) {
    console.error(`❌ ${lockResult.message}`);
    console.error("   Please wait for the other instance to complete or stop it manually.");
    if (lockResult.pid) {
      console.error(`   You can stop the other instance with: kill ${lockResult.pid}`);
    }
    process.exit(1);
  }

  const workspaceDir = process.env.DEVINTERN_WORKSPACE_DIR?.trim();
  if (!workspaceDir || taskKeys.length === 0) return checkoutLock;

  const tickets = acquireTicketLocks(
    taskKeys.map((key) => ({ key, isFilePath: isMarkdownFilePath(key) })),
    workspaceDir,
  );
  if (!tickets.ok) {
    console.error(`❌ ${tickets.message}`);
    checkoutLock.release();
    process.exit(isWorkerSubprocess() ? WORKTREE_BUSY_EXIT_CODE : 1);
  }
  return combineLocks(tickets.locks, checkoutLock);
}
