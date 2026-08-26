/**
 * Tolerant JSON extraction from agent output.
 *
 * Agents don't reliably honor "return ONLY JSON" instructions, and some CLIs
 * mangle the payload on the way out. Observed failure shapes:
 *
 * - fenced ```json blocks (with nested fences inside string values)
 * - bare JSON prefixed by narration ("I'll explore the codebase...")
 * - pretty-printed JSON with literal newlines/tabs inside string values
 * - a stray extra `}` after the closing brace (grok headless)
 * - literal `\n` text between the final value and the closing brace (grok)
 * - unescaped straight double quotes inside string values (`a legacy "cwd" mode`)
 *
 * Try structural candidates from most to least specific, and retry each after
 * progressive repair passes instead of assuming one shape.
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
 * Escape unescaped double quotes inside JSON string literals.
 *
 * Models sometimes quote terms mid-value (`a legacy "cwd" mode`) without
 * escaping, which terminates the JSON string early and corrupts everything
 * after it. A closing quote is only trusted when the next non-whitespace
 * character is a plausible structural token (`,`, `}`, `]`, `:`, or end of
 * text); otherwise the quote is escaped. Best-effort: prose like `"a", "b"`
 * can still fool it, but wrong guesses just produce another failing candidate.
 */
function escapeUnescapedQuotesInStrings(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  const isStructural = (index: number): boolean => {
    let cursor = index;
    while (cursor < text.length && /\s/.test(text.charAt(cursor))) cursor += 1;
    if (cursor >= text.length) return true;
    return ",}]: ".includes(text.charAt(cursor));
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

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

    if (character === "\\") {
      escaped = true;
      result += character;
    } else if (character === '"') {
      if (isStructural(index + 1)) {
        inString = false;
        result += character;
      } else {
        result += '\\"';
      }
    } else {
      result += character;
    }
  }

  return result;
}

/**
 * Slice out every top-level `{...}` object using brace matching that respects
 * string state, so trailing junk after the real closing brace (e.g. grok's
 * stray extra `}`) is excluded.
 */
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
 * Parse the first JSON object found in raw agent output.
 *
 * Candidate order per repair level (none → control chars → control chars +
 * embedded quotes): fenced ```json block, each balanced `{...}` object, the
 * object closed right after its last string value (tolerates junk between the
 * final value and the closing brace), then the whole trimmed text.
 *
 * @param raw - Raw agent stdout.
 * @returns The parsed object.
 * @throws The last `JSON.parse` error when no candidate parses.
 */
export function parseAgentJson<T>(raw: string): T {
  const text = raw.trim();
  const bases: string[] = [];

  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced?.[1]) {
    bases.push(fenced[1]);
  }

  bases.push(...balancedObjectCandidates(text));

  const first = text.indexOf("{");
  if (first !== -1) {
    const lastQuote = text.lastIndexOf('"');
    if (lastQuote > first) {
      bases.push(`${text.slice(first, lastQuote + 1)}}`);
    }
  }

  bases.push(text);

  const variants = [
    ...bases,
    ...bases.map(escapeControlCharsInStrings),
    ...bases.map((base) => escapeUnescapedQuotesInStrings(escapeControlCharsInStrings(base))),
  ];

  let lastError: unknown;
  for (const candidate of variants) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
