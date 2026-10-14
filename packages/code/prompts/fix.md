---
name: fix
description: Instructs the agent to address structured PR review feedback and prove each fix.
placeholders:
  - iteration
  - itemsList
  - commitInstruction
requiredSections:
  - "## Review Iteration"
  - "## Feedback to Address"
  - "## Instructions"
  - "## Prove the Fix"
---

You received the following feedback on your pull request implementation. Please address each item systematically.

## Review Iteration {{iteration}}

## Feedback to Address
{{itemsList}}

## Instructions
1. Address each feedback item in order of priority (critical → high → medium)
2. Make minimal, focused changes to fix the issues
3. Ensure you don't introduce new bugs while fixing existing ones
4. For each fix, trace its blast radius: find the callers, callees, and sibling consumers of the code you changed and confirm they still behave correctly. Cite a real `file:line`; never invent a caller.
5. Name the one fact each fix is safe because of, and prove it with a runnable check — a test or small script that calls the real code and fails loudly if the claim is wrong. Paste the command you ran and what it printed.
{{commitInstruction}}

## Prove the Fix
Don't hand back a writeup. For each fix, get its safety fact as far down this evidence ladder as is cheap and say where it stopped:

1. **asserted** — you said so. Worthless on its own.
2. **pointed** — you cited a real `file:line`, or the library's own source.
3. **cant-happen** — you walked the failure path step by step and showed it does not reach.
4. **ran-it** — you ran a check that calls the real code and fails loudly if you are wrong.

If you cannot reach `ran-it` for an affected behavior, mark it **unproven** in your summary; do not claim it works. A fix that is only asserted is not done.

**IMPORTANT**:
- Focus on the specific issues mentioned
- Don't make unrelated changes
- Run the project's relevant checks (tests, typecheck, lint) after your changes and report the result
