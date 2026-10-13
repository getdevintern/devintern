/**
 * Parse-at-boundary helpers for SQLite rows.
 *
 * `bun:sqlite` returns untyped values, and SQLite does not enforce column
 * types (a `TEXT NOT NULL` column can still hold an integer), so a row that
 * looks like a domain object can hold the wrong runtime shape. These helpers
 * turn `unknown` column values into the declared domain type or throw a
 * descriptive {@link RowParseError}, so malformed persisted data fails at the
 * read boundary instead of flowing through an unchecked `as` cast.
 */

/** Thrown when a persisted SQLite row does not match its declared domain shape. */
export class RowParseError extends Error {
  constructor(context: string, detail: string) {
    super(`${context}: ${detail}`);
    this.name = "RowParseError";
  }
}

/** A raw, not-yet-validated SQLite row. */
export type RowRecord = Record<string, unknown>;

function isRowObject(value: unknown): value is RowRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  return typeof value;
}

/**
 * Narrow an unknown SQLite value to a row object.
 *
 * @param value - Value returned by `.get()` / `.all()`
 * @param context - Human-readable read path used in the error message
 */
export function parseRowObject(value: unknown, context: string): RowRecord {
  if (!isRowObject(value)) {
    throw new RowParseError(context, `expected a row object, got ${describe(value)}`);
  }
  return value;
}

/** Read a required `TEXT` column as a string. */
export function requireString(row: RowRecord, column: string, context: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new RowParseError(context, `column "${column}" must be a string, got ${describe(value)}`);
  }
  return value;
}

/** Read an optional `TEXT` column as a string (SQL `NULL` becomes `undefined`). */
export function optionalString(
  row: RowRecord,
  column: string,
  context: string,
): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new RowParseError(context, `column "${column}" must be a string, got ${describe(value)}`);
  }
  return value;
}

/** Read a required numeric column as a finite number. */
export function requireNumber(row: RowRecord, column: string, context: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RowParseError(
      context,
      `column "${column}" must be a finite number, got ${describe(value)}`,
    );
  }
  return value;
}

/** Read an optional numeric column as a finite number (SQL `NULL` becomes `undefined`). */
export function optionalNumber(
  row: RowRecord,
  column: string,
  context: string,
): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RowParseError(
      context,
      `column "${column}" must be a finite number, got ${describe(value)}`,
    );
  }
  return value;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((candidate) => candidate === value);
}

/** Read a required `TEXT` column constrained to a known union of values. */
export function requireEnum<T extends string>(
  allowed: readonly T[],
  value: unknown,
  column: string,
  context: string,
): T {
  if (!isOneOf(value, allowed)) {
    throw new RowParseError(
      context,
      `column "${column}" must be one of ${allowed.join(", ")}, got ${describe(value)}`,
    );
  }
  return value;
}

/**
 * Read an optional `TEXT` column constrained to a known union of values.
 *
 * Missing columns (legacy schemas) and SQL `NULL` become `undefined` rather
 * than an error, so callers can supply their own default.
 */
export function optionalEnum<T extends string>(
  allowed: readonly T[],
  value: unknown,
  column: string,
  context: string,
): T | undefined {
  if (value === null || value === undefined) return undefined;
  return requireEnum(allowed, value, column, context);
}
