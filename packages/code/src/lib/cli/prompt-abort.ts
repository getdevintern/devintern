/** True for the readline rejection raised when stdin hits EOF (Ctrl+D). */
export function isPromptAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR")
  );
}
