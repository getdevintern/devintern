/**
 * Minimal frontmatter parser for versioned prompt files.
 *
 * Prompt templates are Markdown files that begin with a lightweight,
 * YAML-flavoured header delimited by `---`:
 *
 * ```
 * ---
 * name: clarity
 * description: Pre-implementation feasibility assessment.
 * placeholders:
 *   - key
 *   - summary
 * requiredSections:
 *   - "## Your Role"
 * ---
 * ```
 *
 * The parser intentionally supports only scalar string values and
 * string lists — enough for prompt metadata, without pulling in a YAML
 * dependency. Anything more complex is reported as a malformed line so the
 * prompt lint can fail loudly instead of silently ignoring content.
 */

/** Parsed frontmatter attributes (scalar values or string lists). */
export type FrontmatterAttributes = Record<string, string | string[]>;

/** Result of parsing a prompt file into frontmatter attributes and body. */
export interface FrontmatterParseResult {
  /** Parsed attributes (scalar values or string lists). */
  attributes: FrontmatterAttributes;
  /** Markdown content after the closing `---` delimiter. */
  body: string;
  /** Human-readable parse problems; empty when the file is well-formed. */
  errors: string[];
}

const DELIMITER = "---";
const KEY_PATTERN = /^([A-Za-z0-9_-]+):\s*(.*)$/;
const LIST_ITEM_PATTERN = /^\s*-\s+(.*)$/;

/** Strip a single pair of matching surrounding quotes from a scalar value. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Parse a prompt file's frontmatter header and body.
 *
 * @param raw - Full file contents.
 * @param source - Path or label used in error messages.
 * @returns Parsed attributes, body text, and any parse errors.
 */
export function parseFrontmatter(raw: string, source = "<prompt>"): FrontmatterParseResult {
  const errors: string[] = [];
  const attributes: FrontmatterAttributes = {};

  // Normalize line endings so CRLF files parse identically.
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  // Skip a leading blank line or BOM so authors aren't forced to start at byte 0.
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") {
    start += 1;
  }

  if (lines[start]?.trim() !== DELIMITER) {
    errors.push(`${source}: missing frontmatter (must start with '${DELIMITER}')`);
    return { attributes, body: normalized.trim(), errors };
  }

  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === DELIMITER) {
      end = i;
      break;
    }
  }

  if (end === -1) {
    errors.push(`${source}: unterminated frontmatter (missing closing '${DELIMITER}')`);
    return { attributes, body: "", errors };
  }

  let currentKey: string | null = null;
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }

    const listItem = LIST_ITEM_PATTERN.exec(line);
    if (listItem) {
      if (currentKey === null) {
        errors.push(`${source}: list item without a preceding key (line ${i + 1})`);
        continue;
      }
      const existing = attributes[currentKey];
      const value = unquote(listItem[1]);
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        attributes[currentKey] = [value];
      }
      continue;
    }

    const keyMatch = KEY_PATTERN.exec(line.trim());
    if (!keyMatch) {
      errors.push(`${source}: malformed frontmatter line ${i + 1}: '${line.trim()}'`);
      continue;
    }

    const [, key, rawValue] = keyMatch;
    currentKey = key;
    const value = unquote(rawValue);
    // A key with no inline value is treated as the start of a list; if no list
    // items follow, it remains an empty string.
    attributes[key] = value === "" ? "" : value;
  }

  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "");

  return { attributes, body, errors };
}
