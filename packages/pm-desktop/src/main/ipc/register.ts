import { ipcMain } from "electron";
import { EngineError } from "@getdevintern/pm/engine";
import { PmInitError } from "@getdevintern/pm/init";
import { captureErrorOnce } from "../error-tracking.ts";
import type { IpcResult } from "../../shared/ipc-contract.ts";

function toIpcError(error: unknown): { code: string; message: string; detail?: string } {
  if (error instanceof PmInitError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof EngineError) {
    return { code: error.code, message: error.message, detail: error.detail };
  }
  if (error instanceof Error) {
    const code =
      "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "error";
    return { code, message: error.message };
  }
  return { code: "error", message: String(error) };
}

/**
 * Error codes the handlers raise on purpose for user mistakes (bad input,
 * missing auth, duplicate flow). They surface in the UI as guidance — not
 * bugs — so they are not reported to error tracking.
 */
const USER_ERROR_CODES = new Set(["invalid_input", "auth_required", "in_progress"]);

/** Wrap a handler so failures come back as a typed envelope, never a rejection. */
export function handle<A extends unknown[], T>(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: A) => Promise<T>,
): void {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<T>> => {
    try {
      return { ok: true, value: await handler(event, ...(args as A)) };
    } catch (error) {
      const envelope = toIpcError(error);
      // Handled IPC failures used to be invisible: the envelope converted
      // them away silently. Report real failures (engine/tracker/git errors)
      // with the channel; user mistakes stay unreported. Deduped so a
      // failing operation retried by the UI does not flood Sentry.
      if (!USER_ERROR_CODES.has(envelope.code)) {
        void captureErrorOnce(error, { operation: `ipc:${channel}` });
      }
      return { ok: false, error: envelope };
    }
  });
}
