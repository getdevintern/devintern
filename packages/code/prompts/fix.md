---
name: fix
description: Instructs the agent to address structured PR review feedback.
placeholders:
  - iteration
  - itemsList
  - commitInstruction
requiredSections:
  - "## Review Iteration"
  - "## Feedback to Address"
  - "## Instructions"
---

You received the following feedback on your pull request implementation. Please address each item systematically.

## Review Iteration {{iteration}}

## Feedback to Address
{{itemsList}}

## Instructions
1. Address each feedback item in order of priority (critical → high → medium)
2. Make minimal, focused changes to fix the issues
3. Ensure you don't introduce new bugs while fixing existing ones
{{commitInstruction}}

**IMPORTANT**:
- Focus on the specific issues mentioned
- Don't make unrelated changes
- Test your changes if possible
