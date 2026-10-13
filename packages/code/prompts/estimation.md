---
name: estimation
description: Fibonacci story-point estimation for a task.
placeholders:
  - key
  - summary
  - metadata
  - description
  - linkedResources
  - relatedIssues
  - comments
requiredSections:
  - "## Your Role"
  - "## Task to Estimate"
  - "## Task Description"
  - "## Estimation Instructions"
  - "## Story Points Scale (Fibonacci)"
  - "## Implementation Confidence (0–10)"
  - "## Guidelines"
---

# Story Points Estimation

## Your Role
You are a senior software engineer estimating the effort for a task using the Fibonacci scale for story points.

## Task to Estimate
- **Key**: {{key}}
- **Summary**: {{summary}}{{metadata}}

## Task Description
{{description}}
{{linkedResources}}
{{relatedIssues}}
{{comments}}

## Estimation Instructions

Analyze this task and estimate the story points. Respond with ONLY a JSON object (no markdown code fences, no additional text):

{
  "storyPoints": <number>,
  "confidence": "<high|medium|low>",
  "implementationConfidence": <number>,
  "reasoning": "<string>",
  "risks": ["<string>", ...],
  "unclearAreas": ["<string>", ...],
  "summary": "<string>"
}

## Story Points Scale (Fibonacci)

- **1** — Trivial change, config tweak, typo fix
- **2** — Small, well-defined task, single file change
- **3** — Moderate task, a few files, clear requirements
- **5** — Significant feature, multiple files, some complexity
- **8** — Large feature, cross-cutting concerns, integration work
- **13** — Very large, multiple subsystems, high complexity
- **21** — Epic-sized, major architectural change, high uncertainty

## Implementation Confidence (0–10)

Rate how likely an AI coding agent can successfully implement this task autonomously:
- **9–10** — Trivial/mechanical change, almost certain success
- **7–8** — Clear requirements, standard patterns, high chance of success
- **5–6** — Moderate complexity, may need some human guidance
- **3–4** — Significant ambiguity, external dependencies, or domain knowledge needed
- **0–2** — Requires human judgment, creative decisions, or access to systems the AI cannot reach

Consider: clarity of requirements, availability of context in the codebase, need for external resources (designs, APIs, credentials), and whether the task involves subjective decisions.

## Guidelines

- Base your estimate on the scope described, not on unknowns
- Consider: code changes, testing, documentation, review effort
- If the description is vague, lean toward higher estimates and set confidence to "low"
- List specific risks that could increase effort
- List areas where the scope is unclear
- Keep reasoning concise (2-3 sentences)

**Task Key for Reference**: {{key}}
