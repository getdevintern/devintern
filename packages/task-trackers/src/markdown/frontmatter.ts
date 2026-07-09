export type MarkdownFrontmatter = Record<string, string>;

export interface ParsedMarkdownFrontmatter {
  frontmatter: MarkdownFrontmatter;
  body: string;
  hasFrontmatter: boolean;
}

/**
 * Parse YAML frontmatter (simple key: value pairs) from markdown content.
 */
export function parseMarkdownFrontmatter(content: string): ParsedMarkdownFrontmatter {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const endMarker = "\n---";
  const endIndex = content.indexOf(endMarker, 4);
  if (endIndex === -1) {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const frontmatterStr = content.substring(4, endIndex);
  const body = content.substring(endIndex + endMarker.length).replace(/^\r?\n/, "");

  const frontmatter: MarkdownFrontmatter = {};
  for (const line of frontmatterStr.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      if (key) frontmatter[key] = value;
    }
  }

  return { frontmatter, body, hasFrontmatter: true };
}

/**
 * Update a single frontmatter field, or append it when missing.
 * Does nothing when the file has no frontmatter block.
 */
export function updateMarkdownFrontmatterField(
  content: string,
  field: string,
  value: string,
): string | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return null;
  }

  const endMarker = "\n---";
  const endIndex = content.indexOf(endMarker, 4);
  if (endIndex === -1) {
    return null;
  }

  const frontmatterStr = content.substring(4, endIndex);
  const rest = content.substring(endIndex);
  const fieldPattern = new RegExp(`^${field}:.*$`, "m");

  let updatedFrontmatter: string;
  if (fieldPattern.test(frontmatterStr)) {
    updatedFrontmatter = frontmatterStr.replace(fieldPattern, `${field}: ${value}`);
  } else {
    updatedFrontmatter = `${frontmatterStr.trimEnd()}\n${field}: ${value}\n`;
  }

  return `---\n${updatedFrontmatter}${rest}`;
}

/**
 * Extract the text of the first H1 heading (`# Title`) from markdown content.
 */
export function extractMarkdownTitle(content: string): string | undefined {
  const match = content.match(/^#[ \t]+(.+)$/m);
  return match?.[1]?.trim();
}

/**
 * Derive a stable workflow key from frontmatter or a filename stem.
 */
export function sanitizeMarkdownTaskKey(rawKey: string): string {
  return rawKey
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 80);
}
