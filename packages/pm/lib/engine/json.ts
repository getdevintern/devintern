/**
 * JSON extraction from agent output.
 */

import { parseAgentJson } from "../agent-json.js";
import { EngineError } from "./types.js";

/**
 * Extract and validate a JSON payload from raw agent output.
 *
 * Delegates to {@link parseAgentJson}, which tolerates fenced ```json blocks,
 * bare JSON, and prose-prefixed JSON (some agents narrate before the object).
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
    throw new EngineError(
      "parse-failed",
      error instanceof Error ? error.message : String(error),
      raw,
    );
  }

  if (!validate(parsed)) {
    throw new EngineError("parse-failed", invalidMessage, raw);
  }

  return parsed as T;
}
