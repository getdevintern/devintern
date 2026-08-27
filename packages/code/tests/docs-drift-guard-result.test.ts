import { describe, expect, test } from "bun:test";

import {
  MAX_DRIFT_FINDINGS,
  computeFindingId,
  parseDocsDriftAnalysis,
} from "../src/lib/automations/docs-drift-guard/result";

const FINDING = {
  summary: "Login guide misses the new SSO flow",
  affectedBehavior: "Sign-in now requires choosing an SSO provider",
  evidence: [{ commit: "abc1234def5678", file: "src/auth/sso.ts", detail: "adds SSO" }],
  targetDocuments: ["docs/auth.md"],
  proposedChange: "Document provider selection before password entry",
  severity: "high",
};

function findingsJson(count = 1, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "findings",
    findings: Array.from({ length: count }, () => ({ ...FINDING, ...overrides })),
  });
}

describe("docs-drift-guard structured output validation", () => {
  test("accepts a valid no_drift result", () => {
    const parsed = parseDocsDriftAnalysis('{"status": "no_drift", "findings": []}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.analysis.status).toBe("no_drift");
      expect(parsed.analysis.findings).toHaveLength(0);
    }
  });

  test("accepts fenced or narrated JSON like real agent output", () => {
    const fenced = "Here is my analysis:\n```json\n" + findingsJson() + "\n```\nDone!";
    const parsed = parseDocsDriftAnalysis(fenced);
    expect(parsed.ok).toBe(true);
  });

  test("accepts a fully populated findings result with computed ids", () => {
    const parsed = parseDocsDriftAnalysis(findingsJson());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.analysis.findings[0]?.summary).toContain("SSO");
      expect(parsed.analysis.findings[0]?.id).toMatch(/^[0-9a-f]{16}$/);
      expect(parsed.analysis.findings[0]?.evidence[0]?.commit).toBe("abc1234def5678");
    }
  });

  test("accepts inconclusive with notes", () => {
    const parsed = parseDocsDriftAnalysis(
      '{"status":"inconclusive","findings":[],"notes":"diff was truncated"}',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.analysis.notes).toContain("truncated");
  });

  test("rejects unparsable output", () => {
    const parsed = parseDocsDriftAnalysis("I could not find any drift, everything looks great!");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("not valid JSON");
  });

  test("rejects unknown statuses", () => {
    expect(parseDocsDriftAnalysis('{"status":"clean"}').ok).toBe(false);
    expect(parseDocsDriftAnalysis("{}").ok).toBe(false);
  });

  test("rejects contradictory no_drift with findings", () => {
    const parsed = parseDocsDriftAnalysis(
      JSON.stringify({ status: "no_drift", findings: [FINDING] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("contradicted");
  });

  test("findings status requires at least one finding", () => {
    const parsed = parseDocsDriftAnalysis('{"status":"findings","findings":[]}');
    expect(parsed.ok).toBe(false);
  });

  test("rejects findings with missing or empty required fields", () => {
    for (const key of ["summary", "affectedBehavior", "proposedChange"]) {
      const broken = { ...FINDING, [key]: "" };
      const parsed = parseDocsDriftAnalysis(
        JSON.stringify({ status: "findings", findings: [broken] }),
      );
      expect(parsed.ok, key).toBe(false);
    }
    const noDocs = { ...FINDING, targetDocuments: [] };
    expect(
      parseDocsDriftAnalysis(JSON.stringify({ status: "findings", findings: [noDocs] })).ok,
    ).toBe(false);
    const badEvidence = { ...FINDING, evidence: [{}] };
    expect(
      parseDocsDriftAnalysis(JSON.stringify({ status: "findings", findings: [badEvidence] })).ok,
    ).toBe(false);
  });

  test("rejects unreasonably large finding sets", () => {
    const parsed = parseDocsDriftAnalysis(findingsJson(MAX_DRIFT_FINDINGS + 1));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("too many findings");
  });

  test("rejects invalid severity values", () => {
    const parsed = parseDocsDriftAnalysis(findingsJson(1, { severity: "catastrophic" }));
    expect(parsed.ok).toBe(false);
  });

  test("finding ids are stable across summaries and document order", () => {
    const idFor = (targets: string[], behavior: string) =>
      computeFindingId({ targetDocuments: targets, affectedBehavior: behavior });
    expect(idFor(["docs/b.md", "docs/a.md"], "Added SSO  login")).toBe(
      idFor(["docs/A.md", "docs/B.md"], "added sso login"),
    );
    expect(idFor(["docs/a.md"], "x")).not.toBe(idFor(["docs/a.md"], "y"));
    expect(idFor(["docs/a.md"], "x")).not.toBe(idFor(["docs/b.md"], "x"));
  });
});
