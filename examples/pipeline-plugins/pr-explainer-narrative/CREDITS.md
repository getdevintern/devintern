# Provenance and credits

The narrative explainer adapts guidance from two upstream skills. Both were
inspected at implementation time; this example adapts only prompt guidance for
an unattended pipeline. It does not import upstream publishing commands or
interactive approval workflows.

| Upstream                                             | Revision (pinned)                                  | Licence    | Adapted                  |
| ---------------------------------------------------- | -------------------------------------------------- | ---------- | ------------------------ |
| `mohitagw15856/pm-claude-skills` — `skills/pr-description-live/SKILL.md` | `a07d46e3ef8fd45e4440b6fce31f1007037d8145` | MIT        | Diff-grounded description structure; separating observed facts from inference. |
| `openai/codex` — `.codex/skills/codex-pr-body/SKILL.md` | `18131270fe82ef947830840eb5d6923d4b82609f`       | Apache-2.0 | Motivation / net-change / grouped-by-purpose framing. |

Upstream material remains under its original licence; see each repository for
the full text. This repository's `LICENSE.md` applies to the adaptation and the
surrounding example code.
