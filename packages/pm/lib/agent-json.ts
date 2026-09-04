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
 * - JS-object-literal drift around long rich descriptions: `//` comments,
 *   trailing commas, unquoted or single/smart-quoted keys — reported to users
 *   as "Expected double-quoted property name in JSON" style parse errors
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
 * Shared quote-escape walker parameterized by when a closing double quote is
 * trusted. A closing quote terminates the string only when the lookahead rule
 * approves the position after it; otherwise the quote is escaped.
 */
function escapeQuotesWithRule(
  text: string,
  isTrustedClose: (afterQuoteIndex: number) => boolean,
): string {
  let result = "";
  let inString = false;
  let escaped = false;

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
      if (isTrustedClose(index + 1)) {
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

/** First non-whitespace character at or after `cursor`, or end sentinel. */
function peekNonWhitespace(
  text: string,
  cursor: number,
): { char: string | undefined; atEnd: boolean } {
  let index = cursor;
  while (index < text.length && /\s/.test(text.charAt(index))) index += 1;
  return { char: text[index], atEnd: index >= text.length };
}

/**
 * Escape unescaped double quotes inside JSON string literals.
 *
 * Models sometimes quote terms mid-value (`a legacy "cwd" mode`) without
 * escaping, which terminates the JSON string early and corrupts everything
 * after it. A closing quote is only trusted when the next non-whitespace
 * character is a plausible structural token (`,`, `}`, `]`, `:`); otherwise
 * the quote is escaped. Best-effort: prose like `"a", "b"` can still fool it,
 * but wrong guesses just produce another failing candidate.
 */
function escapeUnescapedQuotesInStrings(text: string): string {
  return escapeQuotesWithRule(text, (afterQuoteIndex) => {
    const { char, atEnd } = peekNonWhitespace(text, afterQuoteIndex);
    if (atEnd || char === undefined) return true;
    return ",}]: ".includes(char);
  });
}

/**
 * Stricter companion to {@link escapeUnescapedQuotesInStrings}: trust a close
 * only when a structural token immediately follows the quote. Markdown bullet
 * lines ending in a quoted word (`... say "done"\nmore prose`) mis-trip the
 * lenient whitespace-skipping variant and flip string state mid-value, which
 * later surfaces as "Expected double-quoted property name" parse errors.
 */
function escapeUnescapedQuotesStrictly(text: string): string {
  return escapeQuotesWithRule(text, (afterQuoteIndex) => {
    const char = text[afterQuoteIndex];
    return afterQuoteIndex >= text.length || char === undefined || ",}]: ".includes(char);
  });
}

/**
 * Remove `//` line comments and `/* ... *\/` block comments outside string
 * literals. JavaScript-literal leakage like `{ // draft below }` makes parsers
 * demand a double-quoted property name and fail. Newlines are preserved so
 * position diagnostics stay meaningful.
 */
function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (!inString) {
      if (character === '"') {
        inString = true;
        result += character;
        continue;
      }
      if (character === "/" && text[index + 1] === "/") {
        while (index < text.length && text[index] !== "\n") index += 1;
        // Keep the newline itself so line/column context stays readable.
        if (index < text.length) result += "\n";
        continue;
      }
      if (character === "/" && text[index + 1] === "*") {
        const end = text.indexOf("*/", index + 2);
        index = end === -1 ? text.length : end + 1;
        continue;
      }
      result += character;
      continue;
    }

    result += character;
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      inString = false;
    }
  }

  return result;
}

/**
 * Remove trailing commas before `}` or `]` (outside strings), another
 * object-literal habit models carry over from JavaScript.
 */
function removeTrailingCommas(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (!inString) {
      if (character === '"') {
        inString = true;
        result += character;
        continue;
      }
      if (character === ",") {
        let cursor = index + 1;
        while (cursor < text.length && /\s/.test(text.charAt(cursor))) cursor += 1;
        if (cursor < text.length && (text[cursor] === "}" || text[cursor] === "]")) {
          continue; // drop the comma; keep following structure
        }
      }
      result += character;
      continue;
    }

    result += character;
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      inString = false;
    }
  }

  return result;
}

const SMART_QUOTES = new Map<string, string>([
  ["\u201c", '"'],
  ["\u201d", '"'],
]);

/**
 * Convert smart/typographic double quotes used as delimiters into straight
 * ones. Apostrophes and single quotes are left alone: they are overwhelmingly
 * legitimate content inside prose values, unlike curly double quotes which no
 * valid JSON contains.
 */
function normalizeSmartQuotes(text: string): string {
  let changed = false;
  let result = "";
  for (const character of text) {
    const replacement = SMART_QUOTES.get(character);
    if (replacement !== undefined) {
      result += replacement;
      changed = true;
    } else {
      result += character;
    }
  }
  return changed ? result : text;
}

/**
 * Quote bare JavaScript-style keys (`summary:` → `"summary":`). Walks outside
 * string literals only, matching an identifier (or a single/smart-quoted key)
 * directly preceding a colon that follows `{` or `,` structure.
 */
function quoteObjectLiteralKeys(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  const structurallyInsideObject = (): boolean => {
    // Cheap approximation: after stripping strings, is the last non-space
    // structural character a `{` or `,`? Good enough for best-effort repair;
    // a wrong guess yields another failing candidate, never silent corruption.
    let depthSquare = 0;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const prior = result[index];
      if (prior === "]") depthSquare += 1;
      else if (prior === "[") {
        if (depthSquare > 0) depthSquare -= 1;
        else return false;
      } else if (prior === "{" || prior === ",") {
        return true;
      } else if (prior === "}") {
        return false;
      }
    }
    return false;
  };

  const collectKey = (start: number): { raw: string; quoted: string } | null => {
    let cursor = start;
    const wrap = (inner: string): { raw: string; quoted: string } => ({
      raw: text.slice(start, cursor),
      quoted: `"${inner.replace(/"/g, '\\"')}"`,
    });

    const current = text[cursor] ?? "";
    if (current === "'") {
      const close = text.indexOf("'", cursor + 1);
      if (close === -1) return null;
      const inner = text.slice(cursor + 1, close);
      cursor = close + 1;
      return { raw: text.slice(start, cursor), quoted: `"${inner.replace(/"/g, '\\"')}"` };
    }
    if (SMART_QUOTES.has(current)) {
      const closeSmart = text.indexOf(current, cursor + 1);
      if (closeSmart === -1) return null;
      const inner = text.slice(cursor + 1, closeSmart);
      cursor = closeSmart + 1;
      return { raw: text.slice(start, cursor), quoted: `"${inner.replace(/"/g, '\\"')}"` };
    }

    let identifierEnd = -1;
    while (cursor < text.length && /[A-Za-z0-9_$]/.test(text.charAt(cursor))) {
      cursor += 1;
      identifierEnd = cursor;
    }
    if (identifierEnd === -1) return null;
    return wrap(text.slice(start, identifierEnd));
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";

    if (!inString) {
      if (/[A-Za-z0-9_$'\u201c\u201d]/.test(character)) {
        const key = collectKey(index);
        if (key && structurallyInsideObject()) {
          let afterKey = index + key.raw.length;
          while (afterKey < text.length && /\s/.test(text.charAt(afterKey))) afterKey += 1;
          if (text[afterKey] === ":") {
            result += `${key.quoted}: `;
            index = afterKey;
            continue;
          }
        }
        result += character;
        continue;
      }
      if (character === '"') inString = true;
      result += character;
      continue;
    }

    result += character;
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      inString = false;
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
 * Ordered repair pipelines applied to every base candidate. Earlier entries
 * keep today's exact behavior; later passes handle progressively stranger
 * JS-object-literal drift seen in live agent output.
 */
function buildVariants(base: string): string[] {
  const controlEscaped = escapeControlCharsInStrings(base);
  const commentsStripped = stripJsonComments(base);
  const commentsControlEscaped = escapeControlCharsInStrings(commentsStripped);

  const variants = [
    base,
    controlEscaped,
    escapeUnescapedQuotesInStrings(controlEscaped),
    escapeUnescapedQuotesStrictly(controlEscaped),
    escapeUnescapedQuotesStrictly(escapeControlCharsInStrings(normalizeSmartQuotes(base))),
    removeTrailingCommas(commentsControlEscaped),
    escapeUnescapedQuotesInStrings(removeTrailingCommas(commentsControlEscaped)),
    quoteObjectLiteralKeys(commentsControlEscaped),
    escapeUnescapedQuotesStrictly(
      quoteObjectLiteralKeys(removeTrailingCommas(commentsControlEscaped)),
    ),
    normalizeSmartQuotes(controlEscaped),
  ];

  return [...new Set(variants)];
}

/** Top-level keys the engine schema actually consumes, in salvage order. */
const KNOWN_KEYS = ["summary", "description", "subtasks"] as const;

const KEY_LINE_PATTERN = new RegExp(`^[ \\t]{0,6}"?(?:${KNOWN_KEYS.join("|")})"?[ \\t]*:`, "m");

/**
 * Last-resort reconstruction for outputs whose quoting is too mangled for the
 * incremental repair passes (e.g. prose like `Pick "one", then "two"` inside a
 * value desyncs every string-state heuristic). Slice each known top-level key's
 * raw value region — from just after its colon to the next key line or closing
 * brace — and re-serialize it via JSON.stringify so anything text-shaped lands
 * back in a valid payload. Only runs against keys this engine actually reads;
 * nonsense outputs produce no candidate at all.
 */
function salvageKnownKeysCandidate(text: string): string | null {
  type Anchor = { key: string; valueStart: number };
  const anchors: Anchor[] = [];
  const pattern = new RegExp(KEY_LINE_PATTERN.source, "gm");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const rawKey = match[0].replace(/^[ \t]*"?/, "").replace(/"?[ \t]*:$/, "");
    if ((KNOWN_KEYS as readonly string[]).includes(rawKey)) {
      anchors.push({ key: rawKey, valueStart: match.index + match[0].length });
      // Avoid re-matching inside a value region.
      pattern.lastIndex = match.index + match[0].length;
    }
  }
  if (anchors.length === 0) return null;

  const entries: string[] = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    if (!anchor) continue;
    let end = text.length;
    const next = anchors[i + 1];
    if (next) {
      // Back up to the start of the next key's line for a clean slice edge.
      end = text.lastIndexOf("\n", next.valueStart - 1) + 1;
    } else {
      const closeBrace = text.indexOf("}", anchor.valueStart);
      if (closeBrace !== -1) end = closeBrace;
    }

    let valueRaw = text.slice(anchor.valueStart, end).trim();
    // Peel fence decorations and delimiter quotes from string values.
    valueRaw = valueRaw
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "")
      .trim();
    if (anchor.key !== "subtasks") {
      // Strip structural decorations outermost-first: separators before
      // delimiter quotes, so `"value",` loses both without eating content.
      valueRaw = valueRaw.replace(/,\s*$/, "").trim();
      if (valueRaw.startsWith('"')) valueRaw = valueRaw.slice(1).trim();
      if (valueRaw.endsWith('"')) valueRaw = valueRaw.slice(0, -1).trim();
      if (valueRaw.length > 0) {
        entries.push(`"${anchor.key}": ${JSON.stringify(valueRaw)}`);
      }
      continue;
    }
    // subtasks must stay an array; only accept it when it round-trips.
    try {
      const parsed = JSON.parse(valueRaw.endsWith(",") ? valueRaw.slice(0, -1) : valueRaw);
      if (Array.isArray(parsed)) {
        entries.push(`"${anchor.key}": ${JSON.stringify(parsed)}`);
      }
    } catch {
      // Not salvageable as an array — omit rather than corrupt the payload.
    }
  }

  return entries.length >= 2 ||
    (entries.length === 1 && (entries[0]?.startsWith('"summary"') ?? false))
    ? `{${entries.join(",")}}`
    : null;
}

/**
 * Parse the first JSON object found in raw agent output.
 *
 * Candidate order per repair level: fenced ```json block, each balanced
 * `{...}` object, the object closed right after its last string value
 * (tolerates junk between the final value and the closing brace), then the
 * whole trimmed text. Each candidate retries through the ordered repair
 * variants so one malformed habit doesn't sink the whole attempt. As a final
 * fallback, a payload is rebuilt from known schema keys.
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

  const salvaged = salvageKnownKeysCandidate(text);
  if (salvaged) {
    bases.push(salvaged);
  }

  bases.push(text);

  let lastError: unknown;
  for (const base of bases) {
    for (const candidate of buildVariants(base)) {
      try {
        return JSON.parse(candidate) as T;
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
