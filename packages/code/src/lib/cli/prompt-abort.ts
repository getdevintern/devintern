/** `cause` of the abort error a prompt session raises for Ctrl+C. */
const INTERRUPT_CAUSE = "SIGINT";

/**
 * True when a prompt stopped because the user left it: readline's rejection
 * when stdin hits EOF (Ctrl+D), or {@link promptInterruptedError} (Ctrl+C).
 */
export function isPromptAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR")
  );
}

/**
 * Abort error for a prompt the user interrupted with Ctrl+C. It satisfies
 * {@link isPromptAbort}, so every "stop setup" path treats it like Ctrl+D;
 * {@link isPromptInterrupt} tells the two apart for the closing message.
 */
export function promptInterruptedError(): Error {
  const error = new Error("Prompt interrupted (Ctrl+C)", { cause: INTERRUPT_CAUSE });
  error.name = "AbortError";
  (error as NodeJS.ErrnoException).code = "ABORT_ERR";
  return error;
}

/** True for {@link promptInterruptedError} (Ctrl+C), false for Ctrl+D and anything else. */
export function isPromptInterrupt(error: unknown): boolean {
  return isPromptAbort(error) && (error as Error).cause === INTERRUPT_CAUSE;
}

/** "Interrupted (Ctrl+C)" or "Input closed (Ctrl+D)", for the line that ends a wizard. */
export function promptAbortReason(error: unknown): string {
  return isPromptInterrupt(error) ? "Interrupted (Ctrl+C)" : "Input closed (Ctrl+D)";
}
