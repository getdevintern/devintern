import { describe, expect, test } from "bun:test";

import { detectOpenQuestions } from "../src/detect-open-questions.js";

describe("detectOpenQuestions", () => {
  test("detects a readiness-check run that ends with numbered decision questions", () => {
    const output = `CLI readiness check is done. **Grok Build** is ready to ship; **GLM** and **DeepSeek** need a product call before I wire them in.

### Ready: Grok Build (xAI)
- Binary: \`grok\`
- Headless: \`grok -p "..."\` with \`--always-approve\` and \`-m <model>\`

### Not first-party yet: DeepSeek
DeepSeek has no official coding CLI.

---

**How should I proceed for DeepSeek and GLM?**

1. **DeepSeek:** Add CodeWhale as \`codewhale\` (honest CLI name), or as \`deepseek\` with docs that the binary is \`codewhale\`?
2. **GLM:** Skip for now and document the gap, add CodeWhale with a \`zai\`/GLM setup note, or pick a specific community CLI?
3. **Scope:** Ship **Grok only** in this PR, or Grok + your DeepSeek/GLM choice together?
`;

    const result = detectOpenQuestions(output);
    expect(result.awaitingInput).toBe(true);
    expect(result.questions.length).toBeGreaterThanOrEqual(3);
    expect(result.questions[0]).toContain("How should I proceed");
  });

  test("detects a single blocking decision question", () => {
    const output = `I reviewed the migration script and the schema.

Do you want me to drop the legacy column as part of this change, or keep it for backward compatibility?`;

    const result = detectOpenQuestions(output);
    expect(result.awaitingInput).toBe(true);
    expect(result.questions).toHaveLength(1);
  });

  test("does not flag a completed implementation summary", () => {
    const output = `## Summary

Implemented the rate limiter as described in the ticket.

- Added a token bucket in src/lib/rate-limit.ts
- Wired it into the webhook server
- Added tests covering burst and refill behavior

All 42 tests pass. Typecheck is clean.`;

    expect(detectOpenQuestions(output).awaitingInput).toBe(false);
  });

  test("does not flag a trailing follow-up offer", () => {
    const output = `Done. The parser now handles quoted fields and escaped delimiters, with tests for both.

Let me know if you want me to also update the CSV export path?`;

    expect(detectOpenQuestions(output).awaitingInput).toBe(false);
  });

  test("ignores questions inside code blocks", () => {
    const output = `Added the FAQ data file.

\`\`\`ts
const faqs = [
  { question: "Should I use bun or npm?" },
  { question: "Which tracker do you want?" },
];
\`\`\`

The page renders all entries and the build passes.`;

    expect(detectOpenQuestions(output).awaitingInput).toBe(false);
  });

  test("ignores questions early in a long run that ends with a completion summary", () => {
    const early = "Which approach should I take? Let me evaluate both options.\n";
    const padding = "Working through the implementation step by step.\n".repeat(200);
    const output = `${early}${padding}\n## Summary\n\nImplemented option A end to end. Tests pass.`;

    expect(detectOpenQuestions(output).awaitingInput).toBe(false);
  });

  test("detects bulleted choice lists phrased as questions", () => {
    const output = `Two viable designs exist and the ticket does not say which.

- Store sessions in Postgres so they survive restarts?
- Keep them in memory and accept logout on deploy?`;

    expect(detectOpenQuestions(output).awaitingInput).toBe(true);
  });
});
