/**
 * Stable report fingerprints for deduplication.
 *
 * The fingerprint intentionally ignores volatile values (ids, numbers, quoted
 * arguments, paths) so a crash loop produces one report with occurrences
 * instead of one report per retry.
 */

import { createHash } from "node:crypto";

export interface FingerprintInput {
  title: string;
  failedStep?: string;
  reason?: string;
  errorName?: string;
  errorMessage?: string;
}

/** Collapse volatile tokens so equivalent failures share a fingerprint. */
export function normalizeForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\b(?:0x)?[0-9a-f]{16,}\b/g, "<hex>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/"[^"\n]*"/g, "<quoted>")
    .replace(/'[^'\n]*'/g, "<quoted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

/** Build a hex SHA-256 fingerprint for a report's failure signature. */
export function buildFingerprint(input: FingerprintInput): string {
  const signature = [
    input.title,
    input.failedStep ?? "",
    input.reason ?? "",
    input.errorName ?? "",
    input.errorMessage ?? "",
  ]
    .map(normalizeForFingerprint)
    .join("|");
  return `sha256:${createHash("sha256").update(signature).digest("hex")}`;
}
