Find and fix documentation that this repository's recent changes made false.

0. Read the repository's contributor docs (AGENTS.md, CLAUDE.md, CONTRIBUTING.md) for documentation rules: where user-facing docs live, which pages own which topics, and style constraints. If they do not say, treat `README*` files, `docs/`, and package READMEs as the documentation. Deduplicate: if an open pull request from this automation (search open PRs whose title contains this automation's id, the task title above) already exists, make no changes and report it.

1. List the pull requests merged into the default branch in the last 7 days (GitHub: `gh pr list --state merged --search "merged:>=<date 7 days ago>" --json number,title,files`; otherwise use `git log` on the default branch for the same window). Skip changes that only touch tests, CI, or docs.

2. For each remaining change, read its diff and find the documentation that describes the changed behavior: commands, flags, configuration keys, environment variables, defaults, API endpoints or signatures, output formats, error messages, and documented workflows.

3. Report a page as drifted only when a statement in it is now false or a documented workflow no longer works: a removed or renamed option still documented, a wrong default or value name, a new required setting that is missing, or changed output that the docs quote. Ignore wording, style, and missing prose; a new optional feature that no page mentions is not drift.

4. Fix only the drifted statements, in the page that owns the topic. Keep edits minimal and factual, follow the repository's documentation rules, and do not add new sections or implementation details. If several unrelated areas drifted, fix the most user-visible one and list the rest in your report instead of widening the change.

5. Verify with the repository's documented docs or format checks, if any; a docs-only change does not need the full test suite.

6. If nothing drifted, make no changes and report that the docs match the recent changes.

Never change code to match the docs; the code is authoritative. The pipeline commits your changes and opens a pull request. Report each drift found with the change that caused it, and each file you edited.
