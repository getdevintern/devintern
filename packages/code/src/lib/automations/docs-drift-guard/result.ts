/**
 * Structured agent output contract for docs-drift-guard analysis.
 *
 * The analysis agent must answer with one JSON object carrying `status`:
 * `no_drift`, `findings`, or `inconclusive`. Unparsable, contradictory, or
 * oversized output is rejected here — an invalid answer must never be
 * interpreted as "documentation is current", so callers fail the run and
 * leave the checkpoint untouched.
 *
 * Commit messages, diffs, and repository documents are untrusted prompt
 * input; this module only trusts the JSON contract, never prose inside it.
 */

import { createHash } from "crypto";

import { parseAgentJsonObject } from "../../agent-json";

export type DriftAnalysisStatus = "no_drift" | "findings" | "inconclusive";

export type DriftFindingSeverity = "low" | "medium" | "high";

/** One piece of supporting evidence for a finding. */
export interface DriftEvidence {
  commit?: string;
  file?: string;
  detail?: string;
}

/** One actionable documentation-drift finding. */
export interface DriftFinding {
  /** Deterministic dedupe key computed from the finding content. */
  id: string;
  summary: string;
  affectedBehavior: string;
  evidence: DriftEvidence[];
  targetDocuments: string[];
  proposedChange: string;
  severity?: DriftFindingSeverity;
}

export interface DocsDriftAnalysis {
  status: DriftAnalysisStatus;
  findings: DriftFinding[];
  notes?: string;
}

export type DocsDriftAnalysisParseResult =
  | { ok: true; analysis: DocsDriftAnalysis }
  | { ok: false; reason: string };

/** Findings above this count are rejected as unreasonably large output. */
export const MAX_DRIFT_FINDINGS = 20;
/** Finding text fields above this length are rejected (bounded tickets/PRs). */
const MAX_FIELD_LENGTH = 4_000;
const SEVERITIES = new Set(["low", "medium", "high"]);

/**
 * Compute the deterministic dedupe key for a finding: findings targeting the
 * same documents with the same affected behavior collapse to one key across
 * runs, enabling ticket deduplication without trusting agent-chosen ids.
 */
export function computeFindingId(input: {
  affectedBehavior: string;
  targetDocuments: string[];
}): string {
  const documents = [...input.targetDocuments]
    .map((doc) => doc.trim().toLowerCase())
    .sort()
    .join("|");
  const behavior = input.affectedBehavior.trim().toLowerCase().replace(/\s+/g, " ");
  return shortHash(`${documents}\n${behavior}`);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Parse and validate raw agent stdout into a {@link DocsDriftAnalysis}. */
export function parseDocsDriftAnalysis(raw: string): DocsDriftAnalysisParseResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseAgentJsonObject(raw, "status");
  } catch (error) {
    return {
      ok: false,
      reason: `agent output is not valid JSON with a "status" key: ${(error as Error).message}`,
    };
  }

  const status = parsed.status;
  if (typeof status !== "string" || !isDriftStatus(status)) {
    return {
      ok: false,
      reason: `status must be one of no_drift, findings, inconclusive (got ${JSON.stringify(status ?? null)})`,
    };
  }

  const notes = optionalText(parsed.notes);
  if (notes === null) {
    return { ok: false, reason: "notes must be a string when present" };
  }

  const rawFindings = parsed.findings ?? [];
  if (!Array.isArray(rawFindings)) {
    return { ok: false, reason: "findings must be an array when present" };
  }

  if (status === "no_drift" && rawFindings.length > 0) {
    return { ok: false, reason: "status no_drift is contradicted by a non-empty findings array" };
  }

  const findings: DriftFinding[] = [];
  if (status === "findings") {
    if (rawFindings.length === 0) {
      return { ok: false, reason: "status findings requires at least one finding" };
    }
    if (rawFindings.length > MAX_DRIFT_FINDINGS) {
      return {
        ok: false,
        reason: `too many findings (${rawFindings.length}); the maximum is ${MAX_DRIFT_FINDINGS}`,
      };
    }
    for (const [index, item] of rawFindings.entries()) {
      const finding = validateFinding(item, index);
      if (typeof finding === "string") return { ok: false, reason: finding };
      findings.push(finding);
    }
  }

  return {
    ok: true,
    analysis: { status, findings, ...(notes !== undefined ? { notes } : {}) },
  };
}

function isDriftStatus(value: string): value is DriftAnalysisStatus {
  return value === "no_drift" || value === "findings" || value === "inconclusive";
}

function validateFinding(item: unknown, index: number): DriftFinding | string {
  const label = `findings[${index}]`;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return `${label} must be an object`;
  }
  const record = item as Record<string, unknown>;

  const summary = requiredText(record.summary, `${label}.summary`);
  if (summary === null) return `${label}.summary must be a non-empty string`;
  const affectedBehavior = requiredText(record.affectedBehavior, `${label}.affectedBehavior`);
  if (affectedBehavior === null) return `${label}.affectedBehavior must be a non-empty string`;
  const proposedChange = requiredText(record.proposedChange, `${label}.proposedChange`);
  if (proposedChange === null) return `${label}.proposedChange must be a non-empty string`;

  const documents = record.targetDocuments;
  if (
    !Array.isArray(documents) ||
    documents.length === 0 ||
    !documents.every((doc) => typeof doc === "string" && doc.trim())
  ) {
    return `${label}.targetDocuments must be a non-empty array of file paths`;
  }
  if (documents.some((doc) => (doc as string).length > MAX_FIELD_LENGTH)) {
    return `${label}.targetDocuments contains an unreasonably long path`;
  }

  const evidence = record.evidence ?? [];
  if (!Array.isArray(evidence)) return `${label}.evidence must be an array when present`;
  const normalizedEvidence: DriftEvidence[] = [];
  for (const [evidenceIndex, entry] of evidence.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return `${label}.evidence[${evidenceIndex}] must be an object`;
    }
    const evidenceRecord = entry as Record<string, unknown>;
    const commit = optionalText(evidenceRecord.commit);
    const file = optionalText(evidenceRecord.file);
    const detail = optionalText(evidenceRecord.detail);
    if (commit === null || file === null || detail === null) {
      return `${label}.evidence[${evidenceIndex}] fields must be strings when present`;
    }
    if (!commit && !file && !detail) {
      return `${label}.evidence[${evidenceIndex}] must include commit, file, or detail`;
    }
    normalizedEvidence.push({
      ...(commit ? { commit } : {}),
      ...(file ? { file } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  const severity = record.severity;
  if (severity !== undefined && (typeof severity !== "string" || !SEVERITIES.has(severity))) {
    return `${label}.severity must be low, medium, or high when present`;
  }

  return {
    id: computeFindingId({ affectedBehavior, targetDocuments: documents as string[] }),
    summary,
    affectedBehavior,
    proposedChange,
    evidence: normalizedEvidence,
    targetDocuments: (documents as string[]).map((doc) => doc.trim()),
    ...(typeof severity === "string" ? { severity: severity as DriftFindingSeverity } : {}),
  };
}

function requiredText(value: unknown, label: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (value.length > MAX_FIELD_LENGTH) return null;
  return value.trim();
}

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  if (value.length > MAX_FIELD_LENGTH) return null;
  return value;
}
