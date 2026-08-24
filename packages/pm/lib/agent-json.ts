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
 * Escape raw control characters inside JSON string literals.
 *
 * Some agents emit pretty-printed JSON where string values (typically long
 * markdown descriptions) contain literal newlines/tabs instead of `\n`/`\t`
 * escapes, which is invalid JSON. This pass walks the text tracking string
 * state and rewrites control characters to their escape sequences.
 */
function escapeControlCharsInStrings(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (const character of text) {
    if (!inString) {
      if (character === '"') inString = true;
      result += character;
      continue;
    }

    if (escaped) {
      escaped = false;
      result += character;
      continue;
    }

    const code = character.codePointAt(0) ?? 0;
    if (character === "\\") {
      escaped = true;
      result += character;
    } else if (character === '"') {
      inString = false;
      result += character;
    } else if (code < 0x20) {
      if (code === 0x0a) {
        result += "\\n";
      } else if (code === 0x0d) {
        result += "\\r";
      } else if (code === 0x09) {
        result += "\\t";
      } else {
        result += `\\u${code.toString(16).padStart(4, "0")}`;
      }
    } else {
      result += character;
    }
  }

  return result;
}

/**
 * Parse the first JSON object found in raw agent output.
 *
 * Candidate order: fenced ```json block, then the outermost `{...}` slice
 * (tolerates leading/trailing prose), then the whole trimmed text; each
 * candidate is retried after escaping raw control characters inside strings
 * (some agents emit pretty-printed JSON with literal newlines in values).
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

  const repaired = candidates.map(escapeControlCharsInStrings);
  candidates.push(...repaired);

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
