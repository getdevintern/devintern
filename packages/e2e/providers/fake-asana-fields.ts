// Asana `opt_fields` handling for the fake Asana tracker: real Asana returns
// only the requested fields, so the fake projects its payloads the same way.

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
