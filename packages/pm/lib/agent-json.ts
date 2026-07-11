/**
 * Tolerant JSON extraction from agent output.
 *
 * Agents don't reliably honor "return ONLY JSON" instructions: some wrap the
 * object in a ```json fence, some emit bare JSON, and some prefix it with a
 * narration line (observed: grok headless prints "I'll explore the
 * codebase..." followed directly by the raw object). Try candidates from most
 * to least specific instead of assuming one shape.
 */

/**
 * Parse the first JSON object found in raw agent output.
 *
 * Candidate order: fenced ```json block, then the outermost `{...}` slice
 * (tolerates leading/trailing prose), then the whole trimmed text.
 *
 * @param raw - Raw agent stdout.
 * @returns The parsed object.
 * @throws The last `JSON.parse` error when no candidate parses.
 */
export function parseAgentJson<T>(raw: string): T {
  const text = raw.trim();
  const candidates: string[] = [];

  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced?.[1]) {
    candidates.push(fenced[1]);
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(text.slice(first, last + 1));
  }

  candidates.push(text);

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
