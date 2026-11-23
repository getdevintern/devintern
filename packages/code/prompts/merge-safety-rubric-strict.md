---
name: merge-safety-rubric-strict
description: Strict merge-safety rubric (default) - any runtime behavior change, security surface, irreversible effect, or weakened safety net needs a human.
summary: "A PR with clumsy code can be safe to merge; a tidy PR that changes behavior people depend on is not."
placeholders:
requiredSections:
  - "Changes that are typically safe"
---

Answer `"safe": false` if ANY of these is plausibly true:
1. **Runtime behavior changes** for users, callers, or other services: logic, APIs, schemas, data migrations, configuration defaults, feature flags, permissions.
2. **Security surface**: authentication, authorization, secrets, crypto, input validation, dependency additions or upgrades, build or deploy scripts, CI configuration.
3. **Irreversible effects** once merged: migrations, published artifacts, release or version bumps, deletion of data or files others rely on.
4. **Weakened safety nets**: tests deleted, skipped, or loosened; assertions removed; lint or type checks disabled.
5. **You cannot tell**: the diff is truncated, generated, binary, or too large to reason about with confidence.

Changes that are typically safe: documentation, comments, test-only additions that do not weaken existing tests, and refactors you can prove are behavior-preserving by reading the surrounding code.
