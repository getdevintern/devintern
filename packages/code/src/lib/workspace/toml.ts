/**
 * Typed shim over Bun's built-in TOML parser.
 *
 * `Bun.TOML` is not part of the published type surface, so the cast lives
 * here. Swapping to an npm parser (e.g. smol-toml) later is a one-file change.
 */

interface BunToml {
  parse(text: string): unknown;
}

/**
 * Parse TOML text into a plain object.
 *
 * @param text - Raw TOML document.
 * @returns Parsed document as a generic record.
 * @throws When the document is not valid TOML.
 */
export function parseToml(text: string): Record<string, unknown> {
  const toml = (Bun as unknown as { TOML: BunToml }).TOML;
  const parsed = toml.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TOML document must be a table at the top level.");
  }
  return parsed as Record<string, unknown>;
}
