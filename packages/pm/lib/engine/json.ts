/**
 * JSON extraction from agent output.
 */

import { parseAgentJson } from "../agent-json.js";
import { EngineError } from "./types.js";

/**
 * Extract and validate a JSON payload from raw agent output.
 *
 * Delegates to {@link parseAgentJson}, which tolerates fenced ```json blocks,
 * bare JSON, prose-prefixed JSON, and common object-literal drift (comments,
 * trailing commas, unquoted keys, stray inner quotes). Failures surface as a
 * friendly {@link EngineError} — the low-level parser diagnostics stay in
 * `detail`, never as the user-facing headline.
 *
 * @param raw - Raw agent stdout.
 * @param validate - Type guard for the expected payload shape.
 * @param invalidMessage - Error message when parsed JSON fails validation.
 * @returns The validated payload.
 * @throws {EngineError} `parse-failed` with the raw output in `detail`.
 */
export function extractJsonPayload<T>(
  raw: string,
  validate: (value: unknown) => value is T,
  invalidMessage: string,
): T {
  let parsed: unknown;
  try {
    parsed = parseAgentJson<unknown>(raw);
  } catch (error) {
    const technical = error instanceof Error ? error.message : String(error);
    throw new EngineError(
      "parse-failed",
      `The agent returned malformed output that could not be repaired automatically (${technical}). Retry the generation, or try another harness/model.`,
      raw,
    );
  }

  if (!validate(parsed)) {
    throw new EngineError("parse-failed", invalidMessage, raw);
  }

  return parsed as T;
}
