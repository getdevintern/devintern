/**
 * Stateless helpers for the in-process Asana fake (`fake-asana.ts`): rich-text
 * conversion, the search query mini-syntax, and JSON responses. `opt_fields`
 * projection lives in `fake-asana-fields.ts`.
 */

/** Filters the product applies after listing a project's tasks. */
export interface FakeAsanaFilters {
  projectGid?: string;
  sectionName?: string;
  assignee?: string;
  completed?: boolean;
  text?: string;
}

/** Escape text for the restricted HTML subset Asana rich text accepts. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render plain text as Asana-style HTML notes. */
export function textToHtml(text: string): string {
  return `<body>${escapeHtml(text).replace(/\n/g, "<br/>")}</body>`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Convert stored Asana `html_text` back to readable plain text.
 *
 * Headings keep their `#` prefixes so the implementation summary asserts on
 * the same literal `## What changed` heading the markdown formatter emitted.
 */
export function htmlToPlainText(html: string): string {
  const structured = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, level: string, inner: string) => `\n${"#".repeat(Number(level))} ${inner}\n`,
    )
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/(p|div|ul|ol|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(structured)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse the `--query` mini-syntax the fake's search endpoint supports. */
export function parseFakeAsanaQuery(query: string): FakeAsanaFilters {
  const filters: FakeAsanaFilters = {};
  const remainder: string[] = [];
  const tokenRegex = /(\w+):(?:"([^"]*)"|(\S+))|(\S+)/g;

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(query)) !== null) {
    const [, key, quoted, bare, free] = match;
    if (free !== undefined) {
      remainder.push(free);
      continue;
    }
    if (key === undefined) continue;
    const value = quoted ?? bare ?? "";
    switch (key.toLowerCase()) {
      case "project":
        filters.projectGid = value;
        break;
      case "section":
        filters.sectionName = value;
        break;
      case "assignee":
        filters.assignee = value;
        break;
      case "completed":
        filters.completed = value.toLowerCase() === "true";
        break;
      default:
        remainder.push(match[0]);
    }
  }

  if (remainder.length > 0) {
    filters.text = remainder.join(" ");
  }
  return filters;
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, message: "Invalid JSON request body" };
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
