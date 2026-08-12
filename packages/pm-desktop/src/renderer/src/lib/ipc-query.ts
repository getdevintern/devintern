import type { IpcError, IpcResult } from "../../../shared/ipc-contract.ts";

/**
 * Unwrap an {@link IpcResult} into its value, throwing {@link IpcError} on
 * failure. Used as the inner of a TanStack Query `queryFn` so the error is
 * surfaced via the query's `error` state instead of a thrown rejection.
 *
 * Every `window.pm.*` query handler returns `IpcResult<T>` rather than
 * throwing (Electron mangles rejected Errors across the IPC boundary), so
 * query functions must unwrap explicitly.
 */
export function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}

export type { IpcError };
