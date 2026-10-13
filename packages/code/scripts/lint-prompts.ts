/**
 * Lint the versioned prompt catalog.
 *
 * Usage: `bun run scripts/lint-prompts.ts [promptsDir]`
 *
 * Exits non-zero when a prompt file has malformed frontmatter, is missing a
 * required section, or references a placeholder that is not declared. Wired
 * into `bun run lint` so the catalog is validated in CI.
 */

import { formatLintIssues, lintPrompts } from "../src/lib/prompts/lint";
import { defaultPromptsDir } from "../src/lib/prompts/loader";

const promptsDir = process.argv[2] ?? defaultPromptsDir();
const issues = lintPrompts(promptsDir);

if (issues.length > 0) {
  console.error(`Prompt lint failed (${issues.length} issue(s)):`);
  console.error(formatLintIssues(issues));
  process.exit(1);
}

console.log(`Prompt lint passed (${promptsDir})`);
