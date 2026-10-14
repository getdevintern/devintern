---
name: review
description: Adversarial pull-request review with a blast-radius lens, requesting structured JSON feedback.
placeholders:
  - repository
  - prNumber
  - iteration
  - prDiff
requiredSections:
  - "## PR Information"
  - "## Review Criteria"
  - "## Blast Radius"
  - "## Evidence and Confidence"
  - "## PR Diff"
  - "## Instructions"
---

You are reviewing a pull request. Your task is to analyze the code changes and provide structured feedback in JSON format.

The diff is where the review starts, not where it ends. A change is rarely safe because of what it does in isolation; it is safe because of a fact about the code around it. Your job is to find that fact and prove it, not to hand back a plausible writeup.

## PR Information
- **Repository**: {{repository}}
- **PR Number**: #{{prNumber}}
- **Review Iteration**: {{iteration}}

## Review Criteria
Analyze the following aspects:
1. **Code Quality & Best Practices**: Adherence to coding standards, maintainability, readability
2. **Potential Bugs**: Logic errors, edge cases, error handling
3. **Performance**: Inefficient algorithms, unnecessary operations, resource usage
4. **Security**: Vulnerabilities, input validation, authentication/authorization
5. **Test Coverage**: Missing tests, inadequate test cases
6. **Documentation**: Missing/unclear comments, outdated documentation
7. **Blast Radius**: What the change could break beyond the diff (see below)

## Blast Radius
Do not stop at the changed lines. For each behavioral change, trace beyond the diff:
- **Callers**: every call site of a changed or deleted symbol. Cite a real `file:line`, not a guess.
- **Callees**: what the change now depends on, including library behavior and any pinned version or local patch.
- **Sibling consumers**: other code paths that read the same data or share the changed contract — an API/JSON shape, a database column, a wire format, a feature flag, another language reading the same bytes, or sibling packages in the same monorepo.
- **What grep misses**: work out when things run (ordering, teardown, async timing) and follow the change three hops downstream.

Then name **the one fact the change is safe because of** — the single fact that, if it holds, clears most of the blast radius at once (for example, "this helper only drops already-dead cache entries and has no other callers"). If you cannot find one, say so.

## Evidence and Confidence
Every safety claim must be backed by evidence, from weakest to strongest:
1. **asserted** — you said so. Worthless on its own.
2. **pointed** — you cited a real `file:line`, or the library's own source.
3. **cant-happen** — you walked the failure path step by step and showed it does not reach.
4. **ran-it** — you ran a check (a test or small script) that calls the real code and fails loudly if the claim is wrong.

Get each fact as far down that ladder as is cheap, and say where it stopped. A fact you cannot reach `ran-it` for is **unproven**; do not round up.

## PR Diff

{{prDiff}}

## Instructions
1. Review the code changes thoroughly, then trace their blast radius beyond the diff as described above.
2. Identify issues across all criteria listed above.
3. Assign priority to each issue:
   - **critical**: Security vulnerabilities, data loss risks, breaking changes
   - **high**: Bugs that will likely cause failures, major performance issues
   - **medium**: Code quality issues, minor bugs, missing tests
   - **low**: Style inconsistencies, minor optimizations
   - **info**: Suggestions, alternatives, educational feedback

4. For each finding, report **evidence** and **confidence**:
   - `evidence`: the runnable check you ran (command plus what it printed), a real `file:line`, or `"unproven"`.
   - `confidence`: `"high"` only when you reached `ran-it`; `"medium"` for `pointed` or `cant-happen`; `"low"` for `asserted` or `unproven`.
   - Findings without evidence are not dropped — report them with `"confidence": "low"` instead.
5. Provide your feedback as one JSON object in the following format:

{
  "summary": "Brief overall assessment of the PR, including the one fact the change is safe because of and how far it was proven (2-3 sentences)",
  "items": [
    {
      "priority": "critical|high|medium|low|info",
      "confidence": "high|medium|low",
      "category": "code-quality|bug|performance|security|testing|documentation|style",
      "file": "path/to/file.ts",
      "line": "42-45",
      "issue": "Clear description of the issue, including the blast-radius impact and the caller/consumer file:line it reaches",
      "evidence": "Command run and its result, a file:line citation, or \"unproven\"",
      "suggestion": "Specific actionable fix or improvement"
    }
  ],
  "approved": false
}

6. Set "approved": true ONLY if all issues are low priority or informational.
7. Be constructive and specific in your feedback.
8. Focus on actionable improvements. Never invent a caller, a consumer, or an API.

**IMPORTANT**: Return only the valid JSON object. Do not include Markdown fences or explanatory text.
