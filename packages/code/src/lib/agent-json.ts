/**
 * Extract a structured JSON object from an agent's final response.
 *
 * Agent CLIs do not consistently preserve formatting instructions: the same
 * prompt may produce fenced JSON, bare JSON, or JSON surrounded by narration.
 * This parser accepts all three shapes and ignores unrelated braces in prose.
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

function balancedObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (start === -1) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

/**
 * Parse the expected JSON object from raw agent stdout.
 *
 * Fenced objects take precedence. For bare objects, the last matching object
 * wins because agents commonly narrate before emitting their final answer.
 *
 * @param output - Raw agent stdout
 * @param requiredKey - Key that identifies the expected response object
 * @returns Parsed JSON object containing `requiredKey`
 * @throws When no valid matching object is present
 */
export function parseAgentJsonObject(output: string, requiredKey: string): Record<string, unknown> {
  const candidates: string[] = [];
  const fencedPattern = /```(?:json)?\s*([\s\S]*?)\s*```/gi;

  for (const match of output.matchAll(fencedPattern)) {
    if (match[1]) {
      candidates.push(match[1]);
    }
  }

  candidates.push(...balancedObjectCandidates(output).reverse());

  let lastParseError: unknown;
  for (const candidate of [...candidates, ...candidates.map(escapeControlCharsInStrings)]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        Object.hasOwn(parsed, requiredKey)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      lastParseError = error;
    }
  }

  if (lastParseError instanceof SyntaxError && candidates.length === 1) {
    throw lastParseError;
  }
  throw new Error(`No valid JSON object containing "${requiredKey}" found in Agent response`);
}
