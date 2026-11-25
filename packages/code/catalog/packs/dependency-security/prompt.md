Fix known security vulnerabilities in this repository's dependencies. Detect the package manager and workspace layout from the lockfiles and manifests, and use that ecosystem's audit tooling (for example `npm audit`, `pnpm audit`, `yarn npm audit`, `bun audit`, `pip-audit`, `cargo audit`, `govulncheck`, `bundle audit`).

0. Read the repository's contributor docs (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, package READMEs) for dependency constraints, such as packages pinned to an exact version or packages with a special release process, and respect them. Then deduplicate: if an open pull request from this automation already exists (search open PRs whose title contains this automation's id, the task title above), or another open PR already addresses the same advisory, skip that work and report it.

1. Audit at severity moderate and above. List each advisory with its package, severity, dependency path, and fixed version.

2. In-range fixes: apply every fix that needs only a lockfile change within each dependent's existing version range (preview with the tool's dry-run mode when it has one, and never use a "latest" mode that rewrites ranges). Batching all of these in one change is intended.

3. Breaking fix: if a high or critical advisory remains, you may make at most ONE out-of-range change in this run, highest severity first:
   - upgrade the direct dependency that constrains the vulnerable package to a release that permits the fixed version, even across a major version; or
   - upgrade the vulnerable direct dependency itself across a major version; or
   - if no fixed release exists and the package is used in only one or two places, replace or remove it.
   Read the changelog or migration guide, update affected code and types, and keep the change limited to that dependency. If the migration needs more than a small, mechanical set of code changes, or touches release, signing, or packaging tooling, do not commit it; report the advisory, the upgrade it needs, and the estimated migration instead.

4. Never widen unrelated ranges, change unrelated dependencies, or silence an advisory with ignores, resolutions, or overrides unless the contributor docs say to. Respect any configured minimum release age or quarantine setting; never bypass it. If the only fixed version is too new, report the advisory as blocked until it ages in.

5. Verify with the repository's documented install (with a frozen lockfile), build, lint, typecheck, and test commands. If the breaking fix fails, drop it and keep the in-range batch; if the batch fails, drop the fix that caused it and verify again. Never leave a broken lockfile. Re-run the audit and record what remains.

6. If nothing is fixable, make no changes and report each remaining advisory with why it is blocked.

The pipeline commits your changes and opens a pull request. Report each advisory fixed (package, from and to version, advisory ID, severity), the breaking change made and the migration it needed, each remaining advisory with why it is blocked, and the verification results.
