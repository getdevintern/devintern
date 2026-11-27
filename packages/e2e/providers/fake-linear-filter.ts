/**
 * Comparator compilers for the fake Linear `IssueFilter` subset (see
 * `compileIssueFilter` in `fake-linear.ts`). Unsupported input returns
 * undefined so the caller rejects the filter instead of matching loosely.
 */

/** Compile a `{gt|gte|lt|lte: ISO}` DateComparator on `updatedAt`. */
export function compileDateCondition<T extends { updatedAt: string }>(
  condition: unknown,
): ((issue: T) => boolean) | undefined {
  const operations = asRecord(condition);
  if (!operations || Object.keys(operations).length === 0) return undefined;

  const matchers: Array<(issue: T) => boolean> = [];
  for (const [operation, rawValue] of Object.entries(operations)) {
    if (typeof rawValue !== "string") return undefined;
    const bound = Date.parse(rawValue);
    if (!Number.isFinite(bound)) return undefined;
    const stamp = (issue: T) => Date.parse(issue.updatedAt);
    switch (operation) {
      case "gt":
        matchers.push((issue) => stamp(issue) > bound);
        break;
      case "gte":
        matchers.push((issue) => stamp(issue) >= bound);
        break;
      case "lt":
        matchers.push((issue) => stamp(issue) < bound);
        break;
      case "lte":
        matchers.push((issue) => stamp(issue) <= bound);
        break;
      default:
        return undefined;
    }
  }
  return (issue) => matchers.every((matcher) => matcher(issue));
}

/** Compile an `{eq|neq}` comparator over a derived string value. */
export function compileEqualityCondition<T>(
  condition: unknown,
  read: (issue: T) => string,
): ((issue: T) => boolean) | undefined {
  const operations = asRecord(condition);
  if (!operations || Object.keys(operations).length === 0) return undefined;

  const matchers: Array<(issue: T) => boolean> = [];
  for (const [operation, rawValue] of Object.entries(operations)) {
    if (typeof rawValue !== "string") return undefined;
    if (operation === "eq") matchers.push((issue) => read(issue) === rawValue);
    else if (operation === "neq") matchers.push((issue) => read(issue) !== rawValue);
    else return undefined;
  }
  return (issue) => matchers.every((matcher) => matcher(issue));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
