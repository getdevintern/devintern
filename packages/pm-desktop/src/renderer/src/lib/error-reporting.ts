/**
 * Renderer-side error reporting.
 *
 * Global window handlers (error / unhandledrejection) plus the React error
 * boundary funnel into {@link reportRendererError}, which forwards to main
 * over the typed IPC contract. Main owns the actual Sentry capture and its
 * opt-outs (telemetry toggle, SENTRY_DISABLED=1); the renderer stays silent
 * about reporting failures so this can never cause UI noise.
 */

import type { RendererErrorReport } from "../../../shared/ipc-contract.ts";

/** Forward an error report to main. Fire-and-forget; never throws. */
export function reportRendererError(report: RendererErrorReport): void {
  try {
    void window.pm?.reportRendererError(report).catch(() => {
      // Reporting must not surface errors of its own (e.g. window closing).
    });
  } catch {
    // Swallow — the bridge may not exist (tests, early teardown).
  }
}

/** Guard so a second install cannot double-report. */
let installed = false;

/**
 * Install global window error handlers. Call once at renderer startup; a
 * second call would double-report, so this guards itself.
 */
export function installGlobalErrorReporting(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (event) => {
    // Resource-load failures (img/script) have no message and no error object.
    if (!event.message && !event.error) return;
    const error = event.error instanceof Error ? event.error : undefined;
    reportRendererError({
      kind: "error",
      message: event.message || error?.message || "Unknown renderer error",
      ...(error?.stack ? { stack: error.stack } : {}),
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    const error = reason instanceof Error ? reason : undefined;
    reportRendererError({
      kind: "unhandledrejection",
      message: error?.message ?? stringifyReason(reason),
      ...(error?.stack ? { stack: error.stack } : {}),
    });
  });
}

function stringifyReason(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason === undefined || reason === null) return "Unknown rejection";
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}
