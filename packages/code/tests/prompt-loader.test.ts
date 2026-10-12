import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseFrontmatter } from "../src/lib/prompts/frontmatter";
import {
  defaultPromptsDir,
  extractPlaceholders,
  loadPrompt,
  renderPrompt,
  resolvePromptPath,
} from "../src/lib/prompts/loader";
import { formatLintIssues, lintPrompts } from "../src/lib/prompts/lint";

const tempDirs: string[] = [];
const originalPromptsDir = process.env.DEVINTERN_PROMPTS_DIR;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prompt-test-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  // Ambient overrides would otherwise let a developer's DEVINTERN_PROMPTS_DIR or
  // a stray `.devintern-code/prompts/` in an ancestor change these results.
  delete process.env.DEVINTERN_PROMPTS_DIR;
});

afterEach(() => {
  if (originalPromptsDir === undefined) {
    delete process.env.DEVINTERN_PROMPTS_DIR;
  } else {
    process.env.DEVINTERN_PROMPTS_DIR = originalPromptsDir;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

/** Pin lookups to the bundled catalog, ignoring environment/project overrides. */
function bundledOptions(): { promptsDir: string; useAmbientOverrides: false } {
  return { promptsDir: defaultPromptsDir(), useAmbientOverrides: false };
}

/** Replacements needed by the clarity and estimation templates. */
function taskReplacements(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    key: "TEST-123",
    summary: "Add user authentication",
    metadata: "\n- **Labels**: backend\n- **Components**: API",
    description: "Implement OAuth2 login flow",
    linkedResources: "## Linked Resources\n\n- **Design spec**: https://docs.example.com/spec",
    relatedIssues:
      "## Related Work Items\n\n- **is child of**: TEST-100 - Parent epic (In Progress)",
    comments: "## Recent Comments\n\n**Alice**: Please use PKCE",
    ...overrides,
  };
}

describe("parseFrontmatter", () => {
  test("parses scalar values and string lists", () => {
    const raw = [
      "---",
      "name: clarity",
      "description: A prompt",
      "placeholders:",
      "  - key",
      "  - summary",
      "requiredSections:",
      '  - "## Your Role"',
      "---",
      "",
      "# Body",
    ].join("\n");

    const { attributes, body, errors } = parseFrontmatter(raw, "clarity.md");

    expect(errors).toEqual([]);
    expect(attributes.name).toBe("clarity");
    expect(attributes.placeholders).toEqual(["key", "summary"]);
    expect(attributes.requiredSections).toEqual(["## Your Role"]);
    expect(body).toContain("# Body");
  });

  test("reports missing frontmatter", () => {
    const { errors } = parseFrontmatter("# Just a heading", "x.md");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("missing frontmatter");
  });

  test("reports unterminated frontmatter", () => {
    const { errors } = parseFrontmatter("---\nname: x\n", "x.md");
    expect(errors[0]).toContain("unterminated frontmatter");
  });

  test("reports malformed lines", () => {
    const { errors } = parseFrontmatter("---\nnot a key\n---\nbody", "x.md");
    expect(errors[0]).toContain("malformed frontmatter line");
  });

  test("reports a list item without a key", () => {
    const { errors } = parseFrontmatter("---\n  - orphan\n---\nbody", "x.md");
    expect(errors[0]).toContain("list item without a preceding key");
  });
});

describe("extractPlaceholders", () => {
  test("returns unique placeholders in first-seen order", () => {
    expect(extractPlaceholders("{{a}} {{b}} {{a}} {{ c }}")).toEqual(["a", "b", "c"]);
  });
});

describe("loadPrompt - bundled catalog", () => {
  test("defaultPromptsDir resolves to an existing directory", () => {
    expect(lintPrompts(defaultPromptsDir())).toEqual([]);
  });

  test("defaultPromptsDir resolves the bundled layout for a dist entry module", () => {
    const metaUrl = "file:///app/dist/index.js";
    const expected = join(dirname(fileURLToPath(metaUrl)), "prompts");

    expect(defaultPromptsDir(metaUrl)).toBe(expected);
    expect(defaultPromptsDir(metaUrl).endsWith(join("dist", "prompts"))).toBe(true);
  });

  test("clarity prompt includes role, task and assessment instructions", () => {
    const prompt = loadPrompt("clarity", taskReplacements(), bundledOptions());

    expect(prompt).toContain("Task Clarity Assessment");
    expect(prompt).toContain("TEST-123");
    expect(prompt).toContain("Add user authentication");
    expect(prompt).toContain("- **Labels**: backend");
    expect(prompt).toContain("Implement OAuth2 login flow");
    expect(prompt).toContain("## Assessment Instructions");
    expect(prompt).toContain("isImplementable");
    expect(prompt).not.toContain("{{");
  });

  test("estimation prompt includes the Fibonacci rubric and JSON shape", () => {
    const prompt = loadPrompt("estimation", taskReplacements(), bundledOptions());

    expect(prompt).toContain("Story Points Estimation");
    expect(prompt).toContain("Fibonacci");
    expect(prompt).toContain('"storyPoints"');
    expect(prompt).toContain('"implementationConfidence"');
    expect(prompt).toContain("## Estimation Instructions");
    expect(prompt).not.toContain("{{");
  });

  test("review prompt includes PR metadata and the diff", () => {
    const prompt = loadPrompt(
      "review",
      {
        repository: "acme/widgets",
        prNumber: "42",
        iteration: "1",
        prDiff: "--- a/x.ts\n+++ b/x.ts\n@@\n-old\n+new",
      },
      bundledOptions(),
    );

    expect(prompt).toContain("acme/widgets");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("Review Iteration");
    expect(prompt).toContain("+new");
    expect(prompt).toContain('"approved": false');
    expect(prompt).not.toContain("{{");
  });

  test("fix prompt includes feedback items and commit instructions", () => {
    const prompt = loadPrompt(
      "fix",
      {
        iteration: "2",
        itemsList: "1. **[HIGH] bug** in `x.ts`\n   - Issue: bad\n   - Suggestion: fix",
        commitInstruction: "4. After making changes, amend them into the previous commit:",
      },
      bundledOptions(),
    );

    expect(prompt).toContain("Review Iteration 2");
    expect(prompt).toContain("[HIGH] bug");
    expect(prompt).toContain("amend them into the previous commit");
    expect(prompt).not.toContain("{{");
  });
});

describe("loadPrompt - overrides", () => {
  test("uses the first override directory that contains the prompt", () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "clarity.md"),
      [
        "---",
        "name: clarity",
        "description: override",
        "placeholders:",
        "  - key",
        "requiredSections:",
        '  - "## Override"',
        "---",
        "",
        "## Override",
        "Custom instructions for {{key}}",
      ].join("\n"),
    );

    const prompt = loadPrompt(
      "clarity",
      { key: "OVR-1" },
      { overrideDirs: [dir], useAmbientOverrides: false },
    );

    expect(prompt).toBe("## Override\nCustom instructions for OVR-1");
    expect(resolvePromptPath("clarity", { overrideDirs: [dir], useAmbientOverrides: false })).toBe(
      join(dir, "clarity.md"),
    );
  });

  test("falls back to the bundled prompt when the override is absent", () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });

    const prompt = loadPrompt("clarity", taskReplacements(), {
      overrideDirs: [dir],
      useAmbientOverrides: false,
    });

    expect(prompt).toContain("Task Clarity Assessment");
  });
});

describe("renderPrompt", () => {
  test("throws on an unresolved placeholder", () => {
    const template = {
      name: "x",
      description: "x",
      placeholders: ["a", "b"],
      requiredSections: [],
      body: "{{a}} {{b}}",
      sourcePath: "x.md",
    };

    expect(() => renderPrompt(template, { a: "1" })).toThrow("unresolved placeholder");
  });

  test("does not re-scan injected values for placeholders", () => {
    const template = {
      name: "review",
      description: "x",
      placeholders: ["prDiff"],
      requiredSections: [],
      body: "diff:\n{{prDiff}}",
      sourcePath: "review.md",
    };

    const rendered = renderPrompt(template, { prDiff: "text with {{notAPlaceholder}}" });

    expect(rendered).toContain("{{notAPlaceholder}}");
  });
});

describe("lintPrompts", () => {
  test("passes the bundled catalog", () => {
    const issues = lintPrompts(defaultPromptsDir());
    expect(formatLintIssues(issues)).toBe("");
  });

  test("flags a missing required section", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "clarity.md"),
      [
        "---",
        "name: clarity",
        "description: broken",
        "placeholders:",
        "  - key",
        "requiredSections:",
        '  - "## Missing"',
        "---",
        "",
        "## Present",
        "{{key}}",
      ].join("\n"),
    );

    const issues = lintPrompts(dir);
    expect(issues.some((issue) => issue.message.includes("missing required section"))).toBe(true);
  });

  test("flags an undeclared placeholder", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "clarity.md"),
      [
        "---",
        "name: clarity",
        "description: broken",
        "placeholders:",
        "  - key",
        "requiredSections:",
        '  - "## Present"',
        "---",
        "",
        "## Present",
        "{{key}} {{undeclared}}",
      ].join("\n"),
    );

    const issues = lintPrompts(dir);
    expect(
      issues.some((issue) => issue.message.includes("'{{undeclared}}' is used but not declared")),
    ).toBe(true);
  });

  test("flags a declared but unused placeholder", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "clarity.md"),
      [
        "---",
        "name: clarity",
        "description: broken",
        "placeholders:",
        "  - key",
        "  - unused",
        "requiredSections:",
        '  - "## Present"',
        "---",
        "",
        "## Present",
        "{{key}}",
      ].join("\n"),
    );

    const issues = lintPrompts(dir);
    expect(
      issues.some((issue) => issue.message.includes("'unused' is declared but never used")),
    ).toBe(true);
  });

  test("flags malformed frontmatter", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "clarity.md"), "# no frontmatter\n");

    const issues = lintPrompts(dir);
    expect(issues.some((issue) => issue.message.includes("missing frontmatter"))).toBe(true);
  });
});

describe("lint script", () => {
  test("exits successfully on the bundled catalog", async () => {
    const script = join(import.meta.dir, "..", "scripts", "lint-prompts.ts");
    const proc = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  test("exits non-zero on a broken catalog", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "broken.md"), "---\nname: broken\n---\nNo required sections\n");

    const script = join(import.meta.dir, "..", "scripts", "lint-prompts.ts");
    const proc = Bun.spawn(["bun", script, dir], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
  });
});
