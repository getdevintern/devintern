/**
 * Stateless helpers for the in-process Asana fake (`fake-asana.ts`): rich-text
 * conversion, the search query mini-syntax, JSON responses, and `opt_fields`
 * projection.
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

/** Fields Asana returns even when `opt_fields` does not name them. */
const ALWAYS_RETURNED_TASK_FIELDS = ["gid"] as const;

/** Task fields in Asana's compact representation, used without `opt_fields`. */
const COMPACT_TASK_FIELDS = ["gid", "name"] as const;

/** Nested tree of requested field names. */
type FieldSelection = Map<string, FieldSelection>;

/** Parse a comma-separated `opt_fields` selector. */
export function parseOptFields(raw: string | null): string[] | undefined {
  const fields = raw
    ?.split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  return fields && fields.length > 0 ? fields : undefined;
}

/** Build a field tree from dotted selectors such as `memberships.section.name`. */
function buildFieldSelection(fields: readonly string[]): FieldSelection {
  const selection: FieldSelection = new Map();
  for (const field of fields) {
    let node = selection;
    for (const segment of field.split(".")) {
      let child = node.get(segment);
      if (!child) {
        child = new Map();
        node.set(segment, child);
      }
      node = child;
    }
  }
  return selection;
}

/** Keep only selected fields, recursing into nested objects and arrays. */
function selectFields(value: unknown, selection: FieldSelection): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => selectFields(entry, selection));
  if (typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const selected: Record<string, unknown> = {};
  for (const [field, children] of selection) {
    if (!(field in record)) continue;
    selected[field] = children.size === 0 ? record[field] : selectFields(record[field], children);
  }
  return selected;
}

/**
 * Project a full task payload onto the request's `opt_fields`.
 *
 * Real Asana always returns `gid` and otherwise includes only the requested
 * fields; omitting the selector returns the compact task. Keeping that behavior
 * means a client that drops a required field from its `opt_fields` loses the
 * field here instead of passing against an unrealistically complete payload.
 */
export function projectTaskPayload(
  payload: Record<string, unknown>,
  optFields: string[] | undefined,
): Record<string, unknown> {
  const selection = buildFieldSelection(optFields ?? COMPACT_TASK_FIELDS);
  for (const field of ALWAYS_RETURNED_TASK_FIELDS) {
    selection.set(field, new Map());
  }
  return selectFields(payload, selection) as Record<string, unknown>;
}
