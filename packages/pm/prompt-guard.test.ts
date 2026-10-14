import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getModuleDir } from "./lib/runtime/path.js";
import {
  REQUIRED_DRAFT_SECTIONS,
  REQUIRED_PROMPT_GUIDANCE,
  findVagueTerms,
  lintDraftDescription,
  lintPromptTemplate,
} from "./lib/engine/prompt-guard.js";

const PROMPTS_DIR = join(getModuleDir(import.meta.url), "prompts");

/** Recursively collect every shipped `.txt` prompt template. */
function collectTemplatePaths(dir: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...collectTemplatePaths(full));
    } else if (entry.isFile() && entry.name.endsWith(".txt")) {
      paths.push(full);
    }
  }
  return paths;
}

/** Every shipped story/decomposition template, discovered from disk. */
function templatePaths(): string[] {
  return collectTemplatePaths(PROMPTS_DIR).sort();
}

/** A well-specified draft that should satisfy the whole rubric. */
const COMPLIANT_DRAFT = `## User Story

As a workspace admin, I want to revoke an invite so that access is removed immediately.

## Acceptance Criteria

- Given an active invite, when the admin revokes it, then the invite status is "revoked"
- Given an already-used invite, when the admin revokes it, then the API returns 409
- Given a revoked invite, when a user opens the link, then they see the "invite no longer valid" page

## Non-goals

- Bulk revocation across workspaces

## Success Metrics

- 100% of revoked invites are rejected within 1 second (p95)
`;

describe("prompt templates enforce the write-spec rubric", () => {
  for (const path of templatePaths()) {
    const relative = path.slice(PROMPTS_DIR.length + 1);
    test(`${relative} requires Given/When/Then, edge cases, non-goals, metrics, and bans vague words`, async () => {
      const template = await readFile(path, "utf-8");
      const result = lintPromptTemplate(template);
      expect(result.missingGuidance).toEqual([]);
      expect(result.valid).toBe(true);
    });

    test(`${relative} scaffolds Non-goals and Success Metrics sections`, async () => {
      const template = await readFile(path, "utf-8");
      expect(template).toContain("## Acceptance Criteria");
      expect(template).toContain("## Non-goals");
      expect(template).toContain("## Success Metrics");
    });
  }

  test("the guidance list itself covers the required rubric ids", () => {
    expect(REQUIRED_PROMPT_GUIDANCE.map((rule) => rule.id)).toEqual([
      "Given/When/Then acceptance criteria",
      "negative and edge cases",
      "explicit non-goals",
      "measurable success metrics",
      "vague-word ban",
    ]);
  });

  test("reports missingGuidance for a template that omits the rubric", () => {
    const result = lintPromptTemplate("Write a concise user story for the change.");
    expect(result.valid).toBe(false);
    expect(result.missingGuidance).toEqual(REQUIRED_PROMPT_GUIDANCE.map((rule) => rule.id));
  });
});

describe("findVagueTerms", () => {
  test("flags the canonical vague words", () => {
    expect(findVagueTerms("A fast, intuitive, and robust experience")).toEqual([
      "fast",
      "intuitive",
      "robust",
    ]);
  });

  test("is case-insensitive", () => {
    expect(findVagueTerms("Seamless and USER-FRIENDLY")).toEqual(["user-friendly", "seamless"]);
  });

  test("is word-bounded so unrelated words do not match", () => {
    expect(findVagueTerms("Breakfast is served in the fastest café")).toEqual([]);
  });

  test("returns no terms for measurable prose", () => {
    expect(findVagueTerms("p95 latency stays under 200 ms across 10k requests")).toEqual([]);
  });

  test("does not flag words that legitimately appear in technical prose", () => {
    expect(
      findVagueTerms("Clean up dead code to keep the API simple, easy, and efficient."),
    ).toEqual([]);
  });
});

describe("lintDraftDescription", () => {
  test("accepts a draft with every section and Given/When/Then criteria", () => {
    const result = lintDraftDescription(COMPLIANT_DRAFT);
    expect(result).toEqual({ missingSections: [], vagueTerms: [], valid: true });
    expect(COMPLIANT_DRAFT).toMatch(/Given .+when .+then/i);
  });

  test("reports missing sections and vague terms", () => {
    const result = lintDraftDescription("The result should be fast and robust.");
    expect(result.missingSections).toEqual([...REQUIRED_DRAFT_SECTIONS]);
    expect(result.vagueTerms).toEqual(["fast", "robust"]);
    expect(result.valid).toBe(false);
  });

  test("reports the specific missing section", () => {
    const result = lintDraftDescription(
      "## Acceptance Criteria\n\n- Given X, when Y, then Z\n\n## Success Metrics\n\n- 100%",
    );
    expect(result.missingSections).toEqual(["Non-goals"]);
    expect(result.valid).toBe(false);
  });

  test("matches sections despite casing, heading level, and hyphenation variance", () => {
    const result = lintDraftDescription(
      "### acceptance criteria\n\n- Given X, when Y, then Z\n\n#### NON GOALS\n\n- Nope\n\n## success metrics\n\n- 100%",
    );
    expect(result.missingSections).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
